export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Pesan tidak valid" });
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

    // Check current usage
    const usageRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usage_limits?identifier=eq.${encodeURIComponent(
        identifier
      )}&day=eq.${today}&select=count`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const usageRows = await usageRes.json();
    const currentCount =
      Array.isArray(usageRows) && usageRows.length > 0 ? usageRows[0].count : 0;

    if (currentCount >= limit) {
      return res.status(429).json({
        error:
          tier === "paid"
            ? `Batas ${limit} pertanyaan hari ini sudah tercapai. Coba lagi besok.`
            : `Batas gratis ${limit} pertanyaan hari ini sudah tercapai. Upgrade ke Pro untuk kuota lebih besar.`,
      });
    }

    let replyText = "";

    if (tier === "paid") {
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
          system:
            "Kamu adalah ZO AI, asisten yang fokus membantu analisis kripto, berita ekonomi, dan strategi trading. Berikan info yang akurat, berimbang, dan berdasarkan data terkini soal market crypto dan makroekonomi. Jangan berikan saran finansial personal (bukan financial advisor), dan selalu ingatkan bahwa keputusan investasi tetap di tangan user. Kamu juga tetap bisa bantu topik umum lain di luar crypto kalau user tanya.",
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
            },
          ],
          messages,
        }),
      });
      const data = await response.json();
      if (data.error) {
        return res
          .status(500)
          .json({ error: data.error.message || "Gagal menghubungi Claude" });
      }
      replyText =
        data.content
          ?.filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n") || "Maaf, tidak ada respons.";
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
        return res
          .status(500)
          .json({ error: data.error.message || "Gagal menghubungi GPT" });
      }
      replyText = data.choices?.[0]?.message?.content || "Maaf, tidak ada respons.";
    }

    // Update usage count (upsert)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/usage_limits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        identifier,
        day: today,
        tier,
        count: currentCount + 1,
      }),
    });

    const remaining = limit - (currentCount + 1);

    return res.status(200).json({ reply: replyText, tier, remaining });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Terjadi kesalahan server" });
  }
}
