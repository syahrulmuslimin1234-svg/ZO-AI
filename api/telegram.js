export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;
    const message = update.message;

    // Ignore non-text updates (stickers, photos, edited messages, etc.)
    if (!message || !message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    // Basic commands
    if (text === "/start") {
      await sendTelegramMessage(
        botToken,
        chatId,
        "Halo! Aku ZO AI 👋\n\nTanya apa aja — bebas, dari nulis, riset, sampai obrolan santai. Langsung ketik pesanmu."
      );
      return res.status(200).json({ ok: true });
    }

    // Show typing indicator
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });

    // Free-tier reply via GPT (mirrors the free tier on the web app)
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        max_tokens: 1024,
        messages: [{ role: "user", content: text }],
      }),
    });
    const aiData = await aiRes.json();

    const replyText =
      aiData.choices?.[0]?.message?.content ||
      "Maaf, lagi ada gangguan. Coba lagi sebentar ya.";

    await sendTelegramMessage(botToken, chatId, replyText);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    // Always return 200 to Telegram so it doesn't keep retrying
    return res.status(200).json({ ok: true });
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
      }
