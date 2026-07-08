export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, accessCode } = req.body;

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

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(401).json({ error: "Kode akses salah" });
      }
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: messages,
      }),
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
      }
