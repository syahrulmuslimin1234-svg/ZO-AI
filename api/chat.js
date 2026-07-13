export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, accessCode } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Pesan tidak valid" });
    }

    let tier = "free";
    let limit = 5;
    let identifier =
      (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();

    // Validate access code if provided
    if (accessCode) {
      const checkRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/subscribers?access_code=eq.${encodeURIComponent(
          accessCode
        )}&status=eq.paid&select=id`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const rows = await checkRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        tier = "paid";
        identifier = accessCode;
        limit = 20;
      } else {
        return res.status(401).json({ error: "Kode akses salah" });
      }
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
          messages,
        }),
      });
      const data = await response.json();
      if (data.error) {
        return res
          .status(500)
          .json({ error: data.error.message || "Gagal menghubungi Claude" });
      }
      replyText = data.content?.[0]?.text || "Maaf, tidak ada respons.";
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
