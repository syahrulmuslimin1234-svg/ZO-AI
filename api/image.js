// Limit generate gambar per hari — beda antara free & paid biar jadi
// insentif upgrade. Ganti angka di bawah kalau mau ubah kuota.
const IMAGE_LIMIT_FREE = 3;
const IMAGE_LIMIT_PAID = 10;

// ---- Filter kata kunci buat nolak prompt yang mengarah ke konten dewasa/
// kekerasan SEBELUM request ke Pollinations dibikin sama sekali. Ini
// pre-check di level teks doang -- nggak nyentuh parameter generate gambar
// (width/height/model/dll), jadi TIDAK mempengaruhi kualitas hasil gambar
// yang lolos filter. Daftar ini nggak bakal sempurna (filter kata kunci
// selalu bisa disiasati), tapi cukup buat nyaring kasus paling jelas/kasar
// sebelum rilis Play Store. ----
const BLOCKED_IMAGE_TERMS = [
  "nude", "naked", "nsfw", "porn", "sex", "sexual", "explicit", "erotic",
  "telanjang", "bugil", "seks", "seksual", "porno", "cabul", "vulgar",
  "gore", "torture", "mutilat", "beheading", "child abuse", "underage",
  "loli", "shota",
];

function containsBlockedTerm(text) {
  const normalized = text.toLowerCase();
  return BLOCKED_IMAGE_TERMS.some((term) => normalized.includes(term));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Invalid prompt" });
    }

    if (containsBlockedTerm(prompt)) {
      return res.status(400).json({
        error: "Deskripsi gambar ini terdeteksi melanggar kebijakan konten. Coba ubah deskripsinya ya.",
      });
    }

    // ---- Wajib login. Tidak ada fallback ke IP address lagi. ----
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!accessToken) {
      return res.status(401).json({
        error: "Please log in to generate images.",
      });
    }

    let identifier = null;
    try {
      const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData?.email) identifier = userData.email;
      }
    } catch (e) {
      console.error("Token verification failed:", e);
    }

    if (!identifier) {
      return res.status(401).json({
        error: "Your session has expired. Please log in again.",
      });
    }

    // ---- Cek status subscriber buat nentuin tier (free/paid) ----
    let isPaid = false;
    try {
      const subRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(
          identifier
        )}&select=expires_at`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (subRes.ok) {
        const subData = await subRes.json();
        const row = Array.isArray(subData) ? subData[0] : null;
        if (row?.expires_at && new Date(row.expires_at) > new Date()) {
          isPaid = true;
        }
      }
    } catch (e) {
      console.error("Subscriber check failed:", e);
    }

    const IMAGE_LIMIT = isPaid ? IMAGE_LIMIT_PAID : IMAGE_LIMIT_FREE;
    const today = new Date().toISOString().slice(0, 10);

    // Pakai RPC atomic yang sama kayak chat.js, tapi identifier dikasih
    // prefix "img:" biar quota gambar TERPISAH dari quota chat teks.
    const usageRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_usage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          p_identifier: `img:${identifier}`,
          p_day: today,
          p_tier: isPaid ? "image_paid" : "image_free",
          p_limit: IMAGE_LIMIT,
        }),
      }
    );
    const usageResult = await usageRes.json();
    const { allowed, new_count } = Array.isArray(usageResult) ? usageResult[0] : usageResult;

    if (!allowed) {
      return res.status(429).json({
        error: `You've reached today's limit of ${IMAGE_LIMIT} generated images. Please try again tomorrow.`,
      });
    }

    // CATATAN: sempat nyoba parameter safe=true (filter NSFW bawaan Pollinations)
    // tapi ternyata bikin KUALITAS GAMBAR TURUN/BLUR buat SEMUA prompt (bukan
    // cuma yang sensitif) -- jadi dilepas lagi. Filter konten sekarang pakai
    // pre-check kata kunci di prompt SEBELUM dikirim ke Pollinations (lihat di
    // atas), jadi nggak ngutak-atik parameter generate/kualitas gambarnya sama sekali.
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const seed = Math.floor(Math.random() * 1e9); // biar tiap generate hasilnya beda walau prompt sama
    const pollinationsUrl =
      `https://image.pollinations.ai/prompt/${encodedPrompt}` +
      `?width=1024&height=1024&model=flux&seed=${seed}&nologo=true`;

    const response = await fetch(pollinationsUrl);
    if (!response.ok) {
      console.error("Pollinations image error:", response.status, response.statusText);
      return res.status(503).json({
        error: "Image generation is busy or our server quota is exhausted. Please try again in a few minutes.",
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = response.headers.get("content-type") || "image/jpeg";
    if (!base64) {
      console.error("Pollinations image: respons kosong.");
      return res.status(500).json({ error: "No image was returned. Please try again." });
    }

    const remaining = Math.max(IMAGE_LIMIT - new_count, 0);
    return res.status(200).json({ image: base64, mimeType, remaining, limit: IMAGE_LIMIT });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong on our server." });
  }
}
