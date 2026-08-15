// Limit generate gambar per hari — beda antara free & paid biar jadi
// insentif upgrade. Ganti angka di bawah kalau mau ubah kuota.
const IMAGE_LIMIT_FREE = 3;
const IMAGE_LIMIT_PAID = 10;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Invalid prompt" });
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

    // Pakai Pollinations.ai (model Flux) -- gratis TANPA BATAS dan TANPA API
    // KEY sama sekali, tinggal request satu URL. Nggak numpang kuota Gemini
    // ataupun perlu billing apa pun. Endpoint klasiknya balikin bytes gambar
    // langsung (bukan JSON), jadi kita fetch terus encode ke base64 sendiri.
    //
    // safe=true ngaktifin filter NSFW bawaan Pollinations (deteksi AI, bukan
    // cuma daftar kata terlarang) -- PENTING buat kepatuhan kebijakan konten
    // Google Play sebelum rilis, biar app nggak generate gambar yang bisa
    // bikin app ditolak/di-suspend pas review.
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const seed = Math.floor(Math.random() * 1e9); // biar tiap generate hasilnya beda walau prompt sama
    const pollinationsUrl =
      `https://image.pollinations.ai/prompt/${encodedPrompt}` +
      `?width=1024&height=1024&model=flux&seed=${seed}&nologo=true&safe=true`;

    const response = await fetch(pollinationsUrl);
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("Pollinations image error:", response.status, response.statusText, bodyText.slice(0, 300));

      // Bedain pesan buat kasus "diblokir filter konten" vs error server biasa,
      // biar user ngerti kenapa gagal dan gak nyoba berkali-kali sia-sia.
      const looksLikeSafetyBlock =
        response.status === 400 ||
        /nsfw|unsafe|safety|inappropriate|blocked/i.test(bodyText);

      if (looksLikeSafetyBlock) {
        return res.status(400).json({
          error: "Deskripsi gambar ini terdeteksi melanggar kebijakan konten (misalnya konten dewasa/kekerasan). Coba ubah deskripsinya ya.",
        });
      }
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
