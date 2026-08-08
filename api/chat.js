// ---- Helper Upstash Redis (REST API, tanpa perlu install package apapun) ----
// Kalau env var belum keset atau Upstash lagi down, fungsi ini balikin null/gagal
// dengan aman -> fitur chat tetap jalan normal, cuma nggak dapet manfaat cache.
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch (e) {
    console.error("Redis GET failed:", e);
    return null;
  }
}

async function redisSet(key, value, ttlSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, value, "EX", String(ttlSeconds)]),
    });
  } catch (e) {
    console.error("Redis SET failed:", e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, webSearchEnabled = true, userMemory = "" } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid message format" });
    }

    let tier = "free";
    let limit = 5;
    let identifier =
      (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();

    // ---- Verifikasi identitas dari access_token, BUKAN dari teks email yang
    // dikirim client. Ini mencegah orang mengaku-aku jadi email siapa pun
    // tanpa benar-benar login lewat OTP. ----
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    let verifiedEmail = null;

    if (accessToken) {
      try {
        const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          verifiedEmail = userData?.email || null;
        }
        // Kalau token invalid/expired, userRes.ok akan false -> verifiedEmail
        // tetap null -> otomatis jatuh ke tier free di bawah, bukan error.
      } catch (e) {
        console.error("Token verification failed:", e);
      }
    }

    // Check subscription status from the VERIFIED email only
    if (verifiedEmail) {
      const nowIso = new Date().toISOString();
      const checkRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(
          verifiedEmail
        )}&status=eq.paid&select=id,expires_at&order=paid_at.desc&limit=1`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const rows = await checkRes.json();
      const sub = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      const stillValid = sub && (!sub.expires_at || sub.expires_at > nowIso);

      if (stillValid) {
        tier = "paid";
        identifier = verifiedEmail;
        limit = 20;
      }
      // Kalau login tapi belum/ga bayar -> tetap lanjut sebagai free tier
      // (identifier tetap IP), bukan error.
    }

    const today = new Date().toISOString().slice(0, 10);

    // Check + reserve usage slot secara atomic (hindari race condition kalau
    // ada 2 request barengan dari identifier yang sama).
    const usageRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        p_identifier: identifier,
        p_day: today,
        p_tier: tier,
        p_limit: limit,
      }),
    });
    const usageResult = await usageRes.json();
    const { allowed, new_count } = Array.isArray(usageResult) ? usageResult[0] : usageResult;

    if (!allowed) {
      return res.status(429).json({
        error:
          tier === "paid"
            ? `You've reached your ${limit} question limit for today. Please try again tomorrow.`
            : `You've reached your free limit of ${limit} questions today. Upgrade to Pro for a bigger quota.`,
        tier,
        limit,
      });
    }

    let replyText = "";

    // Gabungin system prompt dasar + memori user (kalau ada), dipake kedua tier
    const effectiveSystemPrompt =
      userMemory && userMemory.trim()
        ? `${SYSTEM_PROMPT}\n\nBerikut catatan/memori tentang user ini yang perlu kamu ingat & pakai kalau relevan:\n${userMemory.trim()}`
        : SYSTEM_PROMPT;

    if (tier === "paid") {
      replyText = await callClaudeWithTools(messages, webSearchEnabled, effectiveSystemPrompt);
    } else {
      try {
        replyText = await callGeminiWithTools(messages, effectiveSystemPrompt);
      } catch (e) {
        console.error("Gemini error:", e.message);
        return res.status(503).json({
          error: "The AI service is busy or our server quota is exhausted. Please try again in a few minutes.",
        });
      }
    }

    const remaining = limit - new_count;

    return res.status(200).json({ reply: replyText, tier, remaining });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong on our server." });
  }
}

const SYSTEM_PROMPT =
  "Kamu adalah ZO AI, asisten yang fokus membantu analisis kripto, berita ekonomi, dan strategi trading. Berikan info yang akurat, berimbang, dan berdasarkan data terkini soal market crypto dan makroekonomi. Jangan berikan saran finansial personal (bukan financial advisor), dan selalu ingatkan bahwa keputusan investasi tetap di tangan user. Kamu juga tetap bisa bantu topik umum lain di luar crypto kalau user tanya. " +
  "Kamu punya beberapa tool buat ambil data pasar real-time, jangan pernah menebak dari ingatan kamu untuk data yang bisa berubah setiap hari:\n" +
  "- 'get_market_data': harga terkini + berita & sentiment dari Polygon/Massive, buat aset besar (crypto utama & saham).\n" +
  "- 'get_coin_info': harga, market cap, dan perubahan 24 jam dari CoinGecko, buat cakupan token yang lebih luas termasuk token kecil/long-tail yang nggak ada di Polygon.\n" +
  "- 'get_crypto_news': berita kripto terbaru dari CryptoPanic, bisa difilter per koin.\n" +
  "- 'get_fear_greed_index': indeks sentimen pasar kripto keseluruhan (Fear & Greed Index), 0-100.\n" +
  "- 'get_wallet_activity': aktivitas on-chain (transaksi terbaru + saldo) sebuah alamat wallet Ethereum, kalau user kasih alamat wallet spesifik atau nanya soal 'whale'/transaksi besar pada alamat tertentu.";

const MARKET_DATA_TOOL = {
  name: "get_market_data",
  description:
    "Ambil harga terkini (atau harga penutupan terakhir) dan berita terbaru beserta sentiment analysis (positif/negatif/netral) untuk sebuah aset crypto atau saham dari Polygon/Massive API.",
  input_schema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description:
          "Simbol aset. Untuk crypto pakai kode dasar seperti 'BTC', 'ETH', 'SOL'. Untuk saham pakai ticker seperti 'AAPL', 'TSLA'.",
      },
      asset_type: {
        type: "string",
        enum: ["crypto", "stocks"],
        description: "Jenis aset: 'crypto' atau 'stocks'.",
      },
    },
    required: ["symbol", "asset_type"],
  },
};

// ---- Tool baru #1: CoinGecko -- cakupan token jauh lebih luas dari Polygon,
// cocok buat token kecil/long-tail. Gratis, gak perlu API key. ----
const COIN_INFO_TOOL = {
  name: "get_coin_info",
  description:
    "Cari harga, market cap, ranking, dan perubahan 24 jam sebuah cryptocurrency dari CoinGecko. Cakupannya jauh lebih luas dari Polygon (17,000+ koin termasuk token kecil/long-tail), tapi TIDAK menyediakan berita/sentiment -- pakai get_market_data dulu untuk koin besar (BTC, ETH, dll), pakai ini kalau koinnya nggak ketemu di sana atau untuk token yang lebih kecil.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Nama atau simbol coin, contoh: 'pepe', 'PEPE', 'jupiter', 'JUP'.",
      },
    },
    required: ["query"],
  },
};
const GEMINI_COIN_INFO_TOOL = {
  name: "get_coin_info",
  description: COIN_INFO_TOOL.description,
  parameters: {
    type: "OBJECT",
    properties: { query: { type: "STRING", description: COIN_INFO_TOOL.input_schema.properties.query.description } },
    required: ["query"],
  },
};

// ---- Tool baru #2: CryptoPanic -- berita kripto real-time, bisa difilter per koin. ----
const CRYPTO_NEWS_TOOL = {
  name: "get_crypto_news",
  description:
    "Ambil berita kripto terbaru dari CryptoPanic. Bisa difilter berdasarkan koin tertentu, atau kosongkan buat berita umum pasar kripto.",
  input_schema: {
    type: "object",
    properties: {
      currencies: {
        type: "string",
        description: "Opsional. Kode koin dipisah koma, contoh: 'BTC,ETH'. Kosongkan untuk berita umum.",
      },
    },
    required: [],
  },
};
const GEMINI_CRYPTO_NEWS_TOOL = {
  name: "get_crypto_news",
  description: CRYPTO_NEWS_TOOL.description,
  parameters: {
    type: "OBJECT",
    properties: { currencies: { type: "STRING", description: CRYPTO_NEWS_TOOL.input_schema.properties.currencies.description } },
    required: [],
  },
};

// ---- Tool baru #3: Alternative.me -- Fear & Greed Index, gratis tanpa API key. ----
const FEAR_GREED_TOOL = {
  name: "get_fear_greed_index",
  description:
    "Ambil Crypto Fear & Greed Index terkini (skala 0-100, 0=Extreme Fear, 100=Extreme Greed) -- indikator sentimen pasar kripto secara keseluruhan, bukan untuk koin tertentu.",
  input_schema: { type: "object", properties: {}, required: [] },
};
const GEMINI_FEAR_GREED_TOOL = {
  name: "get_fear_greed_index",
  description: FEAR_GREED_TOOL.description,
  parameters: { type: "OBJECT", properties: {}, required: [] },
};

// ---- Tool baru #4: Etherscan -- aktivitas on-chain wallet Ethereum tertentu
// (saldo + transaksi terbaru). Ini BUKAN "deteksi whale otomatis" real-time
// di seluruh jaringan (itu butuh layanan berbayar seperti Whale Alert) --
// scope-nya sengaja dibatasi ke lookup 1 alamat wallet spesifik yang dikasih user. ----
const WALLET_ACTIVITY_TOOL = {
  name: "get_wallet_activity",
  description:
    "Ambil saldo ETH dan daftar transaksi terbaru sebuah alamat wallet Ethereum tertentu dari Etherscan. Pakai ini kalau user kasih alamat wallet spesifik (0x...) dan nanya soal aktivitas/transaksinya. Bukan untuk mendeteksi whale transaction di seluruh jaringan secara otomatis.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Alamat wallet Ethereum, format 0x... (42 karakter)." },
    },
    required: ["address"],
  },
};
const GEMINI_WALLET_ACTIVITY_TOOL = {
  name: "get_wallet_activity",
  description: WALLET_ACTIVITY_TOOL.description,
  parameters: {
    type: "OBJECT",
    properties: { address: { type: "STRING", description: WALLET_ACTIVITY_TOOL.input_schema.properties.address.description } },
    required: ["address"],
  },
};

// Dispatcher tunggal dipakai kedua loop (Claude & Gemini) biar gak duplikat
// logika switch-nya di 2 tempat.
async function runTool(name, args) {
  switch (name) {
    case "get_market_data":
      return await getMarketData(args.symbol, args.asset_type);
    case "get_coin_info":
      return await getCoinInfo(args.query);
    case "get_crypto_news":
      return await getCryptoNews(args.currencies);
    case "get_fear_greed_index":
      return await getFearGreedIndex();
    case "get_wallet_activity":
      return await getWalletActivity(args.address);
    default:
      return "Tool tidak dikenali.";
  }
}

const ALL_TOOLS_CLAUDE = [MARKET_DATA_TOOL, COIN_INFO_TOOL, CRYPTO_NEWS_TOOL, FEAR_GREED_TOOL, WALLET_ACTIVITY_TOOL];
const ALL_TOOLS_GEMINI = [GEMINI_MARKET_TOOL, GEMINI_COIN_INFO_TOOL, GEMINI_CRYPTO_NEWS_TOOL, GEMINI_FEAR_GREED_TOOL, GEMINI_WALLET_ACTIVITY_TOOL];

// Loop function-calling buat Gemini: mirip callClaudeWithTools, tapi format
// request/response beda (functionCall/functionResponse, bukan tool_use/tool_result).
async function callGeminiWithTools(messages, systemPrompt) {
  let contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
    process.env.GEMINI_API_KEY;

  const maxRounds = 3;
  for (let round = 0; round < maxRounds; round++) {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: [{ functionDeclarations: ALL_TOOLS_GEMINI }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || "Gemini error");

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart) {
      // Nggak minta tool -> ini jawaban final. Skip part "thought" (proses mikir internal).
      return (
        parts
          .filter((p) => !p.thought && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim() || "Maaf, tidak ada respons."
      );
    }

    // Model minta data pasar -> jalanin beneran, kirim balik hasilnya ke Gemini
    const { name, args } = functionCallPart.functionCall;
    let toolResultText;
    try {
      toolResultText = await runTool(name, args || {});
    } catch (e) {
      toolResultText = `Gagal mengambil data: ${e.message}`;
    }

    contents.push({ role: "model", parts });
    contents.push({
      role: "user",
      parts: [{ functionResponse: { name, response: { result: toolResultText } } }],
    });
  }

  return "Maaf, terlalu banyak langkah pengambilan data. Coba pertanyaan yang lebih spesifik.";
}

// Loop tool-use: Claude bisa minta data pasar (client-side tool) sekaligus
// pakai web_search (server-side tool, dieksekusi otomatis oleh Anthropic).
// Kita hanya perlu menangani get_market_data secara manual.
async function callClaudeWithTools(messages, webSearchEnabled, systemPrompt) {
  let workingMessages = [...messages];
  const maxRounds = 3;
  const tools = webSearchEnabled
    ? [{ type: "web_search_20250305", name: "web_search" }, ...ALL_TOOLS_CLAUDE]
    : ALL_TOOLS_CLAUDE;

  for (let round = 0; round < maxRounds; round++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt || SYSTEM_PROMPT,
        tools: tools,
        messages: workingMessages,
      }),
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Gagal menghubungi Claude");
    }

    const toolNames = ALL_TOOLS_CLAUDE.map((t) => t.name);
    const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use" && toolNames.includes(b.name));

    if (data.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      return (
        (data.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "Maaf, tidak ada respons."
      );
    }

    // Jalankan tiap tool_use yang diminta Claude, lalu kirim hasilnya kembali.
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let resultText;
        try {
          resultText = await runTool(block.name, block.input || {});
        } catch (e) {
          resultText = `Gagal mengambil data: ${e.message}`;
        }
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
        };
      })
    );

    workingMessages = [
      ...workingMessages,
      { role: "assistant", content: data.content },
      { role: "user", content: toolResults },
    ];
  }

  return "Maaf, terlalu banyak langkah pengambilan data. Coba pertanyaan yang lebih spesifik.";
}

async function getMarketData(symbol, assetType) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return "Data pasar tidak tersedia (POLYGON_API_KEY belum diset di server).";

  const ticker = assetType === "crypto" ? `X:${symbol.toUpperCase()}USD` : symbol.toUpperCase();

  // Cek cache dulu -- kalau ada user lain baru aja nanya simbol yang sama
  // dalam 2 menit terakhir, langsung pake hasil itu, nggak usah hit Polygon lagi.
  const cacheKey = `market:${assetType}:${symbol.toUpperCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  // Harga terakhir (previous close aggregate — cocok untuk free tier Polygon)
  let priceSummary = "Harga tidak tersedia.";
  try {
    const priceRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`
    );
    const priceData = await priceRes.json();
    const bar = priceData?.results?.[0];
    if (bar) {
      const changePercent = (((bar.c - bar.o) / bar.o) * 100).toFixed(2);
      priceSummary = `Close terakhir: $${bar.c} (Open: $${bar.o}, High: $${bar.h}, Low: $${bar.l}, perubahan: ${changePercent}%)`;
    }
  } catch (e) {
    console.error("Polygon price error:", e);
  }

  // Berita + sentiment
  let newsSummary = "Tidak ada berita terbaru.";
  try {
    const newsRes = await fetch(
      `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(
        ticker
      )}&limit=5&order=desc&sort=published_utc&apiKey=${apiKey}`
    );
    const newsData = await newsRes.json();
    const articles = newsData?.results || [];
    if (articles.length > 0) {
      newsSummary = articles
        .map((a) => {
          const insight = a.insights?.find((i) => i.ticker === ticker) || a.insights?.[0];
          const sentiment = insight?.sentiment || "tidak diketahui";
          return `- [${sentiment}] ${a.title} (${a.publisher?.name || "sumber tidak diketahui"}, ${a.published_utc})`;
        })
        .join("\n");
    }
  } catch (e) {
    console.error("Polygon news error:", e);
  }

  const result = `SYMBOL: ${symbol.toUpperCase()} (${assetType})\n\nHARGA:\n${priceSummary}\n\nBERITA & SENTIMENT TERBARU:\n${newsSummary}`;

  // Simpen ke cache 2 menit -- cukup singkat biar harga tetep relevan,
  // tapi cukup buat nampung lonjakan banyak user nanya simbol populer bareng2.
  await redisSet(cacheKey, result, 120);

  return result;
}

// ---- CoinGecko: cakupan token jauh lebih luas dari Polygon. Gratis, gak
// perlu API key sama sekali. Alur: cari coin id via /search, lalu ambil
// detail harga/market cap via /coins/markets. ----
async function getCoinInfo(query) {
  const cacheKey = `coininfo:${query.toLowerCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  try {
    const searchRes = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`
    );
    const searchData = await searchRes.json();
    const coin = searchData?.coins?.[0];
    if (!coin) return `Koin "${query}" tidak ditemukan di CoinGecko.`;

    const marketRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coin.id}&price_change_percentage=24h`
    );
    const marketData = await marketRes.json();
    const m = marketData?.[0];
    if (!m) return `Data harga untuk "${coin.name}" tidak tersedia saat ini.`;

    const result =
      `COIN: ${m.name} (${(m.symbol || "").toUpperCase()})\n` +
      `Harga: $${m.current_price}\n` +
      `Perubahan 24 jam: ${m.price_change_percentage_24h?.toFixed(2) ?? "?"}%\n` +
      `Market cap: $${m.market_cap?.toLocaleString?.() ?? m.market_cap} (ranking #${m.market_cap_rank ?? "?"})\n` +
      `Volume 24 jam: $${m.total_volume?.toLocaleString?.() ?? m.total_volume}\n` +
      `All-time high: $${m.ath} (${m.ath_change_percentage?.toFixed(2) ?? "?"}% dari ATH)`;

    await redisSet(cacheKey, result, 120);
    return result;
  } catch (e) {
    console.error("CoinGecko error:", e);
    return `Gagal mengambil data dari CoinGecko: ${e.message}`;
  }
}

// ---- CryptoPanic: berita kripto real-time, bisa difilter per koin.
// Butuh CRYPTOPANIC_API_KEY (gratis, daftar di cryptopanic.com/developers/api). ----
async function getCryptoNews(currencies) {
  const apiKey = process.env.CRYPTOPANIC_API_KEY;
  if (!apiKey) return "Berita kripto tidak tersedia (CRYPTOPANIC_API_KEY belum diset di server).";

  const cacheKey = `news:${currencies || "general"}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  try {
    let url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&public=true`;
    if (currencies) url += `&currencies=${encodeURIComponent(currencies)}`;

    const res = await fetch(url);
    const data = await res.json();
    const posts = (data?.results || []).slice(0, 6);
    if (posts.length === 0) return "Tidak ada berita terbaru ditemukan.";

    const result = posts
      .map((p) => `- ${p.title} (${p.source?.title || "sumber tidak diketahui"}, ${p.published_at})`)
      .join("\n");

    await redisSet(cacheKey, result, 300); // 5 menit, berita gak seketat harga
    return result;
  } catch (e) {
    console.error("CryptoPanic error:", e);
    return `Gagal mengambil berita: ${e.message}`;
  }
}

// ---- Alternative.me: Crypto Fear & Greed Index. 100% gratis, gak perlu API key. ----
async function getFearGreedIndex() {
  const cacheKey = "feargreed:latest";
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1&format=json");
    const data = await res.json();
    const point = data?.data?.[0];
    if (!point) return "Fear & Greed Index tidak tersedia saat ini.";

    const result = `Fear & Greed Index: ${point.value}/100 (${point.value_classification})`;
    await redisSet(cacheKey, result, 600); // update sekali per hari, cache 10 menit cukup
    return result;
  } catch (e) {
    console.error("Fear & Greed error:", e);
    return `Gagal mengambil Fear & Greed Index: ${e.message}`;
  }
}

// ---- Etherscan: saldo + transaksi terbaru sebuah alamat wallet Ethereum.
// Butuh ETHERSCAN_API_KEY (gratis, daftar di etherscan.io/apis). Scope-nya
// SATU alamat spesifik yang dikasih user -- bukan deteksi whale otomatis
// di seluruh jaringan (itu perlu layanan berbayar terpisah). ----
async function getWalletActivity(address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return "Data wallet tidak tersedia (ETHERSCAN_API_KEY belum diset di server).";
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || "")) return "Alamat wallet tidak valid. Harus format 0x... (42 karakter).";

  const cacheKey = `wallet:${address.toLowerCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  try {
    const [balRes, txRes] = await Promise.all([
      fetch(`https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${apiKey}`),
      fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=5&apikey=${apiKey}`),
    ]);
    const balData = await balRes.json();
    const txData = await txRes.json();

    const ethBalance = balData?.result ? (Number(balData.result) / 1e18).toFixed(4) : "?";
    const txs = Array.isArray(txData?.result) ? txData.result : [];

    const txSummary =
      txs.length > 0
        ? txs
            .map((tx) => {
              const valEth = (Number(tx.value) / 1e18).toFixed(4);
              const date = new Date(Number(tx.timeStamp) * 1000).toISOString();
              return `- ${valEth} ETH dari ${tx.from} ke ${tx.to} (${date})`;
            })
            .join("\n")
        : "Belum ada transaksi tercatat.";

    const result = `WALLET: ${address}\nSaldo: ${ethBalance} ETH\n\n5 transaksi terakhir:\n${txSummary}`;
    await redisSet(cacheKey, result, 60); // 1 menit, aktivitas wallet perlu cukup fresh
    return result;
  } catch (e) {
    console.error("Etherscan error:", e);
    return `Gagal mengambil data wallet: ${e.message}`;
  }
}
