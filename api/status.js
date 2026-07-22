export default async function handler(req, res) {
  try {
    let tier = "free";
    let limit = 5;
    let identifier =
      (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();

    // ---- Verifikasi identitas dari access_token, sama kayak chat.js ----
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
      } catch (e) {
        console.error("Token verification failed:", e);
      }
    }

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
    }

    const today = new Date().toISOString().slice(0, 10);

    // Read-only: cuma SELECT count, gak nambahin apa-apa (beda dari chat.js
    // yang pakai RPC atomic-increment).
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

    const remaining = Math.max(limit - currentCount, 0);

    return res.status(200).json({ tier, remaining, limit });
  } catch (err) {
    console.error(err);
    // Gagal cek status bukan error fatal — biarin frontend anggap "belum tau",
    // jangan blokir user buat tetap coba chat.
    return res.status(200).json({ tier: "free", remaining: null, limit: null });
  }
}
