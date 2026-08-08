import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

app.use(express.json());
app.use(express.static("public"));

// ---------- Shared helper: ask Mistral ----------
async function askMistral(message) {
  const response = await fetch(
    "https://api.mistral.ai/v1/conversations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        inputs: [
          {
            role: "user",
            content: message
          }
        ],
        tools: [],
        completion_args: {
          temperature: 0.7,
          max_tokens: 2048,
          top_p: 1
        },
        instructions: ""
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error(
      typeof data.error === "string" ? data.error : "خطا در ارتباط با Mistral"
    );
  }

  return (
    data.outputs?.find(item => item.type === "message.output")?.content
    ?? data.outputs?.[0]?.content
    ?? "پاسخی دریافت نشد."
  );
}

// ---------- Website chat endpoint ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "پیام خالی است"
      });
    }

    const answer = await askMistral(message);

    res.json({ answer });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "خطا در اتصال به Mistral API"
    });
  }
});

// ---------- Telegram bot webhook ----------
app.post("/telegram-webhook", async (req, res) => {
  // Acknowledge Telegram immediately so it doesn't retry the update
  res.sendStatus(200);


  console.log("Incoming Telegram update:", JSON.stringify(req.body));

  if (!TELEGRAM_API) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "سلام 👋 من یک ربات هوش مصنوعی هستم.\nهر سوالی داری بپرس تا برات جواب بدم 🤖"
      );
      return;
    }

    if (!text) return;

    const answer = await askMistral(text);
    await sendTelegramMessage(chatId, answer);

  } catch (error) {
    console.error("Telegram webhook error:", error);
  }
});

async function sendTelegramMessage(chatId, text) {
  // Telegram limits messages to ~4096 characters, split long replies
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];

  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk
      })
    });
  }
}

// Simple health check (useful for uptime pings)
app.get("/health", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
