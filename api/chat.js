export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, webSearchEnabled = true } = req.body;

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
      });
    }

    let replyText = "";

    if (tier === "paid") {
      replyText = await callClaudeWithTools(messages, webSearchEnabled);
    } else {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-nano",
          max_tokens: 1024,
          messages,
        }),
      });
      const data = await response.json();
      if (data.error) {
        console.error("OpenAI error:", data.error.message);
        return res.status(503).json({
          error: "The AI service is busy or our server quota is exhausted. Please try again in a few minutes.",
        });
      }
      replyText = data.choices?.[0]?.message?.content || "Maaf, tidak ada respons.";
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
  "Kamu punya akses ke tool 'get_market_data' untuk mengambil harga terkini dan berita + sentiment analysis dari Massive (Polygon) untuk crypto maupun saham. Gunakan tool ini kalau user bertanya soal harga, sentiment, atau berita terbaru suatu aset — jangan menebak dari ingatan kamu untuk data yang bisa berubah setiap hari.";

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

// Loop tool-use: Claude bisa minta data pasar (client-side tool) sekaligus
// pakai web_search (server-side tool, dieksekusi otomatis oleh Anthropic).
// Kita hanya perlu menangani get_market_data secara manual.
async function callClaudeWithTools(messages, webSearchEnabled) {
  let workingMessages = [...messages];
  const maxRounds = 3;
  const tools = webSearchEnabled
    ? [{ type: "web_search_20250305", name: "web_search" }, MARKET_DATA_TOOL]
    : [MARKET_DATA_TOOL];

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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: tools,
        messages: workingMessages,
      }),
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Gagal menghubungi Claude");
    }

    const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use" && b.name === "get_market_data");

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
          resultText = await getMarketData(block.input.symbol, block.input.asset_type);
        } catch (e) {
          resultText = `Gagal mengambil data pasar: ${e.message}`;
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

  return `SYMBOL: ${symbol.toUpperCase()} (${assetType})\n\nHARGA:\n${priceSummary}\n\nBERITA & SENTIMENT TERBARU:\n${newsSummary}`;
}
