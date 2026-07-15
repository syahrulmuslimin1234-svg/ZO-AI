export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email } = req.body || {};

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Email wajib diisi dan harus valid" });
    }

    const cleanEmail = email.toLowerCase().trim();

    const orderId =
      "ZOAI-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

    const insertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        order_id: orderId,
        email: cleanEmail,
        status: "pending",
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error("Supabase insert error:", errText);
      return res.status(500).json({ error: "Gagal menyiapkan transaksi" });
    }

    const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify({
        price_amount: 15,
        price_currency: "usd",
        order_id: orderId,
        order_description: "Langganan ZO AI - 1 bulan",
        ipn_callback_url: `${process.env.SITE_URL}/api/webhook/nowpayments`,
        success_url: `${process.env.SITE_URL}/success.html?order_id=${orderId}`,
        cancel_url: `${process.env.SITE_URL}/bayar.html`,
      }),
    });

    const npData = await npRes.json();

    if (!npRes.ok) {
      console.error("NOWPayments error:", npData);
      return res.status(500).json({ error: "Gagal membuat invoice pembayaran" });
    }

    res.status(200).json({ invoice_url: npData.invoice_url, order_id: orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
}
