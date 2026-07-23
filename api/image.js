// Limit generate gambar per hari — SAMA buat semua orang (free & paid),
// karena biaya generate gambar beda dari chat teks biasa.
const IMAGE_LIMIT = 3;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Invalid prompt" });
    }

    let identifier =
      (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();

    // ---- Verifikasi identitas dari access_token, sama kayak chat.js ----
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

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
          if (userData?.email) identifier = userData.email;
        }
      } catch (e) {
        console.error("Token verification failed:", e);
      }
    }

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
          p_tier: "image",
          p_limit: IMAGE_LIMIT,
        }),
      }
    );
    const usageResult = await usageRes.json();
    const { allowed, new_count } = Array.isArray(usageResult) ? usageResult[0] : usageResult;

    if (!allowed) {
      return res.status(429).json({
        error: `You've reached today's limit of ${IMAGE_LIMIT} generated images. Please try again tomorrow.`,
        limit: IMAGE_LIMIT,
      });
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: prompt.trim(),
        size: "1024x1024",
        n: 1,
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.error("OpenAI image error:", data.error.message);
      return res.status(503).json({
        error: "Image generation is busy or our server quota is exhausted. Please try again in a few minutes.",
      });
    }

    const base64 = data.data?.[0]?.b64_json;
    if (!base64) {
      return res.status(500).json({ error: "No image was returned. Please try again." });
    }

    const remaining = Math.max(IMAGE_LIMIT - new_count, 0);
    return res.status(200).json({ image: base64, remaining, limit: IMAGE_LIMIT });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong on our server." });
  }
}
