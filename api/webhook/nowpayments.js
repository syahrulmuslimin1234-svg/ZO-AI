import crypto from "crypto";

function sortObjectKeys(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  } else if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature) {
      return res.status(400).json({ error: "Signature tidak ditemukan" });
    }

    const sortedBody = sortObjectKeys(req.body);
    const sortedString = JSON.stringify(sortedBody);

    const hmac = crypto
      .createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET)
      .update(sortedString)
      .digest("hex");

    if (hmac !== signature) {
      console.error("Signature NOWPayments tidak cocok");
      return res.status(401).json({ error: "Signature tidak valid" });
    }

    const { order_id, payment_status } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: "order_id tidak ada" });
    }

    if (payment_status === "finished" || payment_status === "confirmed") {
      const accessCode = crypto.randomBytes(6).toString("hex").toUpperCase();
      const paidAt = new Date();
      const expiresAt = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      const updateRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/subscribers?order_id=eq.${order_id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            status: "paid",
            access_code: accessCode,
            paid_at: paidAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          }),
        }
      );

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        console.error("Gagal update Supabase:", errText);
        return res.status(500).json({ error: "Gagal update data pembayaran" });
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
}
