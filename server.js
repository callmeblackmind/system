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

// حافظه‌ی موقت مکالمه‌ی هر چت (اگر سرور دوباره استارت بشه، پاک می‌شود)
const chatConversations = new Map();

const MAIN_KEYBOARD = {
  keyboard: [
    ["🆕 چت جدید", "❌ لغو"],
    ["📖 راهنما", "ℹ️ درباره ربات"]
  ],
  resize_keyboard: true
};

const HELP_TEXT =
  "📖 راهنما\n\n" +
  "هر سوالی داری همینجا بنویس تا جواب بدم.\n\n" +
  "🆕 چت جدید — مکالمه رو از صفر شروع می‌کنه\n" +
  "❌ لغو — مکالمه‌ی فعلی رو پاک می‌کنه\n" +
  "📖 راهنما — همین پیام\n" +
  "ℹ️ درباره ربات — توضیح کوتاه درباره من";

const ABOUT_TEXT =
  "ℹ️ درباره ربات\n\n" +
  "من یک دستیار هوش مصنوعی هستم و برای پاسخ به سوالات شما اینجا هستم 🤖";

const WELCOME_TEXT =
  "سلام 👋 من یک ربات هوش مصنوعی هستم.\nهر سوالی داری بپرس تا برات جواب بدم 🤖";

app.use(express.json());
app.use(express.static("public"));

// ---------- Shared helper: ask Mistral ----------
async function askMistral(message, conversationId) {
  const url = conversationId
    ? `https://api.mistral.ai/v1/conversations/${conversationId}`
    : "https://api.mistral.ai/v1/conversations";

  const body = conversationId
    ? { inputs: message }
    : {
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
      };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Mistral API error:", JSON.stringify(data));
    throw new Error(
      typeof data.error === "string" ? data.error : "خطا در ارتباط با Mistral"
    );
  }

  const answer =
    data.outputs?.find(item => item.type === "message.output")?.content
    ?? data.outputs?.[0]?.content
    ?? "پاسخی دریافت نشد.";

  return {
    answer,
    conversationId: data.conversation_id ?? conversationId
  };
}

// ---------- Website chat endpoint (بدون حافظه‌ی مکالمه) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "پیام خالی است"
      });
    }

    const { answer } = await askMistral(message);

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

    // دستورات اسلش (از منوی Menu کنار جعبه پیام) و دکمه‌های متنی هر دو پشتیبانی می‌شوند
    if (text === "/start") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(chatId, WELCOME_TEXT, MAIN_KEYBOARD);
      return;
    }

    if (text === "/new" || text === "🆕 چت جدید") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(
        chatId,
        "✅ چت جدید شروع شد. حالا می‌تونی سوالت رو بپرسی.",
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "/cancel" || text === "❌ لغو") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(
        chatId,
        "❌ لغو شد. هر وقت خواستی دوباره پیام بده.",
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "/help" || text === "📖 راهنما") {
      await sendTelegramMessage(chatId, HELP_TEXT, MAIN_KEYBOARD);
      return;
    }

    if (text === "/about" || text === "ℹ️ درباره ربات") {
      await sendTelegramMessage(chatId, ABOUT_TEXT, MAIN_KEYBOARD);
      return;
    }

    if (!text) return;

    const existingConversationId = chatConversations.get(chatId);
    const { answer, conversationId } = await askMistral(text, existingConversationId);

    if (conversationId) {
      chatConversations.set(chatId, conversationId);
    }

    await sendTelegramMessage(chatId, answer, MAIN_KEYBOARD);

  } catch (error) {
    console.error("Telegram webhook error:", error);
  }
});

async function sendTelegramMessage(chatId, text, keyboard) {
  // Telegram limits messages to ~4096 characters, split long replies
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;

    const body = {
      chat_id: chatId,
      text: chunks[i]
    };

    // فقط روی آخرین تکه پیام، دکمه‌ها را نشان بده
    if (isLastChunk && keyboard) {
      body.reply_markup = keyboard;
    }

    try {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const result = await response.json();

      if (!result.ok) {
        console.error("Telegram sendMessage FAILED:", JSON.stringify(result));
      }

    } catch (error) {
      console.error("Telegram sendMessage request crashed:", error);
    }
  }
}

// Simple health check (useful for uptime pings)
app.get("/health", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
