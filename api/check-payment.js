export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { order_id } = req.query;
  if (!order_id) {
    return res.status(400).json({ error: "order_id wajib diisi" });
  }

  try {
    const supabaseRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscribers?order_id=eq.${encodeURIComponent(
        order_id
      )}&select=status,access_code`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const data = await supabaseRes.json();
    const record = data && data[0];

    if (!record) {
      return res.status(404).json({ error: "Order tidak ditemukan" });
    }

    if (record.status === "paid") {
      return res.status(200).json({ paid: true, access_code: record.access_code });
    }

    res.status(200).json({ paid: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
}
