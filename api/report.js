// ============================================================================
// ZO AI DEEP RESEARCH -- riset multi-sumber otomatis + laporan PDF profesional
// ============================================================================
// File ini SENGAJA berdiri sendiri (gak import dari chat.js) biar fitur chat
// yang udah stabil gak ikut kena risiko kalau ada bug di fitur baru ini.
// Konsekuensinya beberapa fungsi (redisGet/redisSet, runTool, dll) jadi
// terduplikasi dari chat.js -- itu trade-off yang sengaja diambil demi
// keamanan, bukan lupa nge-refactor.
//
// Fitur ini KHUSUS PREMIUM (paid tier) -- riset berlapis + generate PDF makan
// lebih banyak panggilan API dibanding chat biasa, jadi digerbang biar biaya
// server terkendali dan jadi insentif nyata buat upgrade ke Premium.
// ============================================================================

import PDFDocument from "pdfkit";

// ---- Redis (cache + rate limit report) ----
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

async function redisIncrWithExpiry(key, ttlSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 1; // Redis gak keset -> jangan blokir, anggap request pertama
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(ttlSeconds)]]),
    });
    const data = await res.json();
    return Array.isArray(data) ? Number(data[0]?.result || 1) : 1;
  } catch (e) {
    console.error("Redis INCR failed:", e);
    return 1;
  }
}

// ---- Tool-tool riset (versi ringkas -- sama sumber datanya kayak chat.js) ----
async function getMarketData(symbol, assetType) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return "Data pasar tidak tersedia.";
  try {
    const tickerPrefix = assetType === "crypto" ? `X:${symbol.toUpperCase()}USD` : symbol.toUpperCase();
    const res = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${tickerPrefix}/prev?adjusted=true&apiKey=${apiKey}`
    );
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return `Data harga untuk ${symbol} tidak ditemukan.`;
    return `${symbol.toUpperCase()}: Buka $${r.o}, Tertinggi $${r.h}, Terendah $${r.l}, Tutup $${r.c}, Volume ${r.v}`;
  } catch (e) {
    return `Gagal mengambil data pasar ${symbol}: ${e.message}`;
  }
}

async function getCoinInfo(query) {
  try {
    const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
    const searchData = await searchRes.json();
    const coin = searchData?.coins?.[0];
    if (!coin) return `Koin "${query}" tidak ditemukan.`;
    const marketRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coin.id}&price_change_percentage=24h,7d,30d`
    );
    const m = (await marketRes.json())?.[0];
    if (!m) return `Data untuk "${coin.name}" tidak tersedia.`;
    return (
      `${m.name} (${(m.symbol || "").toUpperCase()}): Harga $${m.current_price}, ` +
      `24 jam ${m.price_change_percentage_24h?.toFixed(2) ?? "?"}%, ` +
      `7 hari ${m.price_change_percentage_7d_in_currency?.toFixed(2) ?? "?"}%, ` +
      `30 hari ${m.price_change_percentage_30d_in_currency?.toFixed(2) ?? "?"}%, ` +
      `Market cap $${m.market_cap?.toLocaleString?.() ?? m.market_cap} (rank #${m.market_cap_rank ?? "?"}), ` +
      `Volume 24 jam $${m.total_volume?.toLocaleString?.() ?? m.total_volume}, ` +
      `ATH $${m.ath} (${m.ath_change_percentage?.toFixed(2) ?? "?"}% dari ATH)`
    );
  } catch (e) {
    return `Gagal mengambil data koin: ${e.message}`;
  }
}

async function getFearGreedIndex() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=7&format=json");
    const data = await res.json();
    const points = data?.data || [];
    if (points.length === 0) return "Fear & Greed Index tidak tersedia.";
    return points.map((p) => `${new Date(p.timestamp * 1000).toLocaleDateString("id-ID")}: ${p.value}/100 (${p.value_classification})`).join("\n");
  } catch (e) {
    return `Gagal mengambil Fear & Greed Index: ${e.message}`;
  }
}

async function getEtfFlowData(asset) {
  const paths = { bitcoin: "btc", ethereum: "eth", solana: "sol" };
  const key = (asset || "bitcoin").toLowerCase();
  const path = paths[key] || "btc";
  try {
    const res = await fetch(`https://farside.co.uk/${path}/`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZOAI/1.0)" },
    });
    const html = await res.text();
    const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    const table = tableMatches.find((t) => /\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(t));
    if (!table) return "Data ETF flow tidak ditemukan.";
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const parsedRows = rows
      .map((row) => (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()))
      .filter((r) => r.length > 1 && r.some((c) => c));
    const dateRows = parsedRows.filter((r) => /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(r[0]));
    if (dateRows.length === 0) return "Data ETF flow tidak terbaca.";
    return dateRows.slice(-7).map((r) => `${r[0]}: ${r[r.length - 1]} juta USD`).join("\n");
  } catch (e) {
    return `Gagal mengambil data ETF flow: ${e.message}`;
  }
}

const RESEARCH_TOOLS = [
  {
    name: "get_market_data",
    description: "Harga terkini aset besar (crypto utama & saham) dari Polygon.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Simbol aset, contoh 'BTC', 'AAPL'." },
        asset_type: { type: "string", enum: ["crypto", "stocks"] },
      },
      required: ["symbol", "asset_type"],
    },
  },
  {
    name: "get_coin_info",
    description: "Harga, market cap, ranking, perubahan 24 jam/7 hari/30 hari sebuah cryptocurrency (cakupan lebih luas dari get_market_data).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_fear_greed_index",
    description: "Fear & Greed Index 7 hari terakhir.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_etf_flow_data",
    description: "Data arus dana ETF spot Bitcoin/Ethereum/Solana 7 hari terakhir.",
    input_schema: {
      type: "object",
      properties: { asset: { type: "string", enum: ["bitcoin", "ethereum", "solana"] } },
      required: ["asset"],
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case "get_market_data":
      return await getMarketData(args.symbol, args.asset_type);
    case "get_coin_info":
      return await getCoinInfo(args.query);
    case "get_fear_greed_index":
      return await getFearGreedIndex();
    case "get_etf_flow_data":
      return await getEtfFlowData(args.asset);
    default:
      return "Tool tidak dikenali.";
  }
}

const RESEARCH_SYSTEM_PROMPT =
  "Kamu adalah mesin riset ZO AI Deep Research. Tugas kamu: melakukan riset MENDALAM dan BERLAPIS " +
  "(bukan cuma satu kali cek data) atas topik yang diminta user, menggunakan semua tool yang tersedia " +
  "(data pasar, info koin, Fear & Greed Index, arus dana ETF) DAN pencarian web buat berita/konteks terkini. " +
  "Gali dari beberapa sudut sebelum menyimpulkan: harga & tren, sentimen pasar, arus dana institusional, " +
  "berita/katalis terkini, dan risiko yang relevan. Jangan buru-buru menjawab di ronde pertama -- pakai " +
  "beberapa tool secara berurutan dulu kalau topiknya memungkinkan.\n\n" +
  "Setelah riset selesai, tulis LAPORAN LENGKAP dalam Bahasa Indonesia dengan format section persis begini " +
  "(pakai tanda ## di depan tiap judul section, HARUS pakai semua section ini secara berurutan):\n" +
  "## Ringkasan Eksekutif\n" +
  "(2-3 paragraf ringkasan temuan utama)\n" +
  "## Data Pasar Terkini\n" +
  "(harga, perubahan, volume, market cap -- dalam bentuk paragraf naratif, bukan cuma angka mentah)\n" +
  "## Sentimen Pasar\n" +
  "(analisis Fear & Greed Index dan makna tren sentimennya)\n" +
  "## Arus Dana Institusional\n" +
  "(kalau relevan/tersedia -- analisis ETF flow, apa artinya buat sentimen institusi)\n" +
  "## Berita & Konteks Terkini\n" +
  "(rangkuman berita/katalis terkini dari pencarian web, TANPA menyebut nama sumber/website spesifik)\n" +
  "## Kesimpulan & Catatan Risiko\n" +
  "(kesimpulan objektif + pengingat ini bukan saran finansial, murni edukasi/riset)\n\n" +
  "PENTING: jangan pernah sebut nama provider data/API pihak ketiga spesifik apa pun ke pembaca laporan.";

async function deepResearch(topic) {
  let messages = [{ role: "user", content: `Buat laporan riset mendalam soal: ${topic}` }];
  const tools = [{ type: "web_search_20250305", name: "web_search" }, ...RESEARCH_TOOLS];
  const maxRounds = 6; // lebih banyak dari chat biasa (3) -- ini emang didesain buat riset berlapis

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
        system: RESEARCH_SYSTEM_PROMPT,
        tools,
        messages,
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || "Gagal menghubungi Claude");

    const toolNames = RESEARCH_TOOLS.map((t) => t.name);
    const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use" && toolNames.includes(b.name));

    if (data.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let resultText;
        try {
          resultText = await runTool(block.name, block.input || {});
        } catch (e) {
          resultText = `Gagal mengambil data: ${e.message}`;
        }
        return { type: "tool_result", tool_use_id: block.id, content: resultText };
      })
    );

    messages = [...messages, { role: "assistant", content: data.content }, { role: "user", content: toolResults }];
  }

  throw new Error("Riset terlalu panjang, coba topik yang lebih spesifik.");
}

// ---- Render laporan jadi PDF pakai pdfkit ----
async function buildPdf(topic, reportText) {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const RED = "#e3242b";
  const INK = "#111111";
  const MUTED = "#666666";

  // ---- Cover page ----
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#0a0a0a");
  try {
    const logoRes = await fetch("https://zo-ai.vercel.app/assets/logo2-192.png");
    if (logoRes.ok) {
      const logoBuf = Buffer.from(await logoRes.arrayBuffer());
      doc.image(logoBuf, doc.page.width / 2 - 40, 140, { width: 80 });
    }
  } catch (e) {
    console.error("Gagal muat logo buat cover PDF:", e);
  }
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text("ZO AI", 0, 250, { align: "center" });
  doc.fillColor(RED).font("Helvetica-Bold").fontSize(28).text("LAPORAN RISET", 0, 340, { align: "center" });
  doc.fillColor("#ffffff").font("Helvetica").fontSize(16).text(topic, 60, 385, { align: "center", width: doc.page.width - 120 });
  doc.fillColor("#999999").font("Helvetica").fontSize(10).text(
    new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }),
    0, 460, { align: "center" }
  );
  doc.fillColor("#555555").fontSize(8).text("Dibuat otomatis oleh ZO AI Deep Research", 0, doc.page.height - 60, { align: "center" });

  // ---- Isi laporan ----
  doc.addPage();
  const sections = reportText.split(/^##\s+/m).filter((s) => s.trim());

  sections.forEach((section, i) => {
    const lines = section.split("\n");
    const heading = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    if (doc.y > doc.page.height - 150) doc.addPage();

    doc.moveDown(i === 0 ? 0 : 1);
    doc.fillColor(RED).font("Helvetica-Bold").fontSize(15).text(heading);
    doc.moveTo(doc.x, doc.y + 2).lineTo(doc.x + 80, doc.y + 2).strokeColor(RED).lineWidth(2).stroke();
    doc.moveDown(0.6);
    doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(body, { align: "left", lineGap: 3 });
  });

  // ---- Footer tiap halaman ----
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica").text(
      "ZO AI bisa saja salah -- laporan ini bersifat edukasi/riset, bukan saran finansial. Selalu lakukan riset mandiri sebelum mengambil keputusan investasi.",
      50, doc.page.height - 40, { width: doc.page.width - 100, align: "center" }
    );
  }

  doc.end();
  return done;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { topic } = req.body;
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "Topik riset kosong." });
    }

    // ---- Verifikasi identitas (sama pola kayak chat.js) ----
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!accessToken) return res.status(401).json({ error: "Perlu login buat pakai fitur ini." });

    let verifiedEmail = null;
    try {
      const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${accessToken}` },
      });
      if (userRes.ok) verifiedEmail = (await userRes.json())?.email || null;
    } catch (e) {
      console.error("Token verification failed:", e);
    }
    if (!verifiedEmail) return res.status(401).json({ error: "Sesi login tidak valid, coba login ulang." });

    // ---- Fitur khusus Premium ----
    const nowIso = new Date().toISOString();
    const checkRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(verifiedEmail)}&status=eq.paid&select=id,expires_at&order=paid_at.desc&limit=1`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = await checkRes.json();
    const sub = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const stillValid = sub && (!sub.expires_at || sub.expires_at > nowIso);
    if (!stillValid) {
      return res.status(403).json({ error: "ZO AI Deep Research khusus buat pengguna Premium. Upgrade dulu buat pakai fitur ini." });
    }

    // ---- Limit 3 laporan/hari per user Premium (bukan limit chat biasa) ----
    const today = new Date().toISOString().slice(0, 10);
    const usageCount = await redisIncrWithExpiry(`report_usage:${verifiedEmail}:${today}`, 172800);
    const REPORT_LIMIT = 3;
    if (usageCount > REPORT_LIMIT) {
      return res.status(429).json({ error: `Kamu udah bikin ${REPORT_LIMIT} laporan hari ini. Coba lagi besok ya.` });
    }

    const reportText = await deepResearch(topic.trim());
    const pdfBuffer = await buildPdf(topic.trim(), reportText);
    const base64 = pdfBuffer.toString("base64");

    return res.status(200).json({
      pdf: base64,
      filename: `ZO-AI-Riset-${Date.now()}.pdf`,
      remaining: REPORT_LIMIT - usageCount,
    });
  } catch (e) {
    console.error("Report generation error:", e);
    return res.status(500).json({ error: "Gagal membuat laporan: " + e.message });
  }
}
