import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

// آیدی عددی تلگرام خودت و رمز عبور پنل ادمین (هر دو را در Render تنظیم کن)
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID
  ? Number(process.env.ADMIN_TELEGRAM_ID)
  : null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ---------- ذخیره‌سازی ساده روی فایل (برای توکن‌ها) ----------
const DATA_FILE = "./data.json";

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (!data.users) data.users = [];
    return data;
  } catch {
    return { tokens: {}, users: [] };
  }
}

// هر چت‌آیدی که تا حالا با ربات پیام رد و بدل کرده را برای اعلامیه‌ها ثبت کن
function trackUser(chatId) {
  if (!db.users.includes(chatId)) {
    db.users.push(chatId);
    saveData(db);
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function generateToken() {
  return crypto.randomBytes(4).toString("hex"); // مثلا: a1b2c3d4
}

// آیا این چت اجازه‌ی صحبت با هوش مصنوعی را دارد؟
function isAuthorized(chatId) {
  if (ADMIN_TELEGRAM_ID && chatId === ADMIN_TELEGRAM_ID) return true;

  return Object.values(db.tokens).some(
    t => t.usedBy === chatId && t.active
  );
}

// ---------- حافظه‌ی موقت مکالمه و وضعیت‌های در انتظار ----------
const chatConversations = new Map();
const pendingAction = new Map(); // chatId -> "admin_password" | "redeem_token"
const adminSessions = new Set(); // chatId هایی که با موفقیت لاگین ادمین کرده‌اند

const MAIN_KEYBOARD = {
  keyboard: [
    ["🆕 چت جدید", "❌ لغو"],
    ["📖 راهنما", "ℹ️ درباره ربات"],
    ["🔑 وارد کردن توکن"]
  ],
  resize_keyboard: true
};

const ADMIN_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🎫 ساخت توکن جدید", callback_data: "admin_new_token" }],
    [{ text: "📋 لیست توکن‌ها", callback_data: "admin_list_tokens" }],
    [{ text: "📢 ارسال اعلامیه", callback_data: "admin_broadcast" }]
  ]
};

const HELP_TEXT =
  "📖 راهنما\n\n" +
  "هر سوالی داری همینجا بنویس تا جواب بدم.\n\n" +
  "🆕 چت جدید — مکالمه رو از صفر شروع می‌کنه\n" +
  "❌ لغو — مکالمه‌ی فعلی رو پاک می‌کنه\n" +
  "🔑 وارد کردن توکن — فعال‌سازی دسترسی با توکن\n" +
  "📖 راهنما — همین پیام\n" +
  "ℹ️ درباره ربات — توضیح کوتاه درباره من";

const ABOUT_TEXT =
  "ℹ️ درباره ربات\n\n" +
  "من یک دستیار هوش مصنوعی هستم و برای پاسخ به سوالات شما اینجا هستم 🤖";

const WELCOME_TEXT =
  "سلام 👋 من یک ربات هوش مصنوعی هستم.\nهر سوالی داری بپرس تا برات جواب بدم 🤖";

const NEED_TOKEN_TEXT =
  "🔒 برای استفاده از ربات به یک توکن دسترسی نیاز داری.\n" +
  "روی دکمه‌ی «🔑 وارد کردن توکن» بزن و توکن رو بفرست.";

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
        inputs: [{ role: "user", content: message }],
        tools: [],
        completion_args: { temperature: 0.7, max_tokens: 2048, top_p: 1 },
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

  return { answer, conversationId: data.conversation_id ?? conversationId };
}

// ---------- Website chat endpoint (بدون سیستم توکن) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "پیام خالی است" });
    }
    const { answer } = await askMistral(message);
    res.json({ answer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "خطا در اتصال به Mistral API" });
  }
});

// ---------- Telegram bot webhook ----------
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);

  console.log("Incoming Telegram update:", JSON.stringify(req.body));

  if (!TELEGRAM_API) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  try {
    // دکمه‌های شیشه‌ای پنل ادمین
    if (req.body.callback_query) {
      await handleCallbackQuery(req.body.callback_query);
      return;
    }

    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    trackUser(chatId);

    // ---------- دستور مخفی پنل ادمین (در منوی عمومی ثبت نشده) ----------
    if (text === "/admin") {
      if (!ADMIN_TELEGRAM_ID || chatId !== ADMIN_TELEGRAM_ID) return; // سکوت کامل برای غیر ادمین
      pendingAction.set(chatId, "admin_password");
      await sendTelegramMessage(chatId, "🔐 رمز عبور پنل ادمین را وارد کن:");
      return;
    }

    // در انتظار وارد کردن رمز پنل ادمین
    if (pendingAction.get(chatId) === "admin_password") {
      pendingAction.delete(chatId);
      if (text === ADMIN_PASSWORD) {
        adminSessions.add(chatId);
        await sendTelegramMessageWithMarkup(chatId, "✅ وارد پنل ادمین شدی:", ADMIN_KEYBOARD);
      } else {
        await sendTelegramMessage(chatId, "❌ رمز اشتباه است.");
      }
      return;
    }

    // ---------- دکمه‌های عمومی ----------
    if (text === "/start") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(
        chatId,
        isAuthorized(chatId) ? WELCOME_TEXT : WELCOME_TEXT + "\n\n" + NEED_TOKEN_TEXT,
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "/new" || text === "🆕 چت جدید") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(chatId, "✅ چت جدید شروع شد.", MAIN_KEYBOARD);
      return;
    }

    if (text === "/cancel" || text === "❌ لغو") {
      chatConversations.delete(chatId);
      pendingAction.delete(chatId);
      await sendTelegramMessage(chatId, "❌ لغو شد.", MAIN_KEYBOARD);
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

    // در انتظار متن اعلامیه از ادمین
    if (pendingAction.get(chatId) === "broadcast_message") {
      pendingAction.delete(chatId);
      await broadcastMessage(chatId, text);
      return;
    }

    // ---------- ورود توکن ----------
    if (text === "/token" || text === "🔑 وارد کردن توکن") {
      pendingAction.set(chatId, "redeem_token");
      await sendTelegramMessage(chatId, "🔑 توکن خودت را ارسال کن:");
      return;
    }

    if (pendingAction.get(chatId) === "redeem_token") {
      pendingAction.delete(chatId);
      const token = db.tokens[text];

      if (!token) {
        await sendTelegramMessage(chatId, "❌ این توکن معتبر نیست.", MAIN_KEYBOARD);
      } else if (!token.active) {
        await sendTelegramMessage(chatId, "🔒 این توکن غیرفعال شده است.", MAIN_KEYBOARD);
      } else if (token.usedBy && token.usedBy !== chatId) {
        await sendTelegramMessage(chatId, "❌ این توکن قبلاً توسط شخص دیگری استفاده شده است.", MAIN_KEYBOARD);
      } else {
        token.usedBy = chatId;
        saveData(db);
        await sendTelegramMessage(chatId, "✅ توکن با موفقیت فعال شد! حالا می‌تونی سوالت رو بپرسی.", MAIN_KEYBOARD);
      }
      return;
    }

    // ---------- چت با هوش مصنوعی (فقط برای کاربران مجاز) ----------
    if (!isAuthorized(chatId)) {
      await sendTelegramMessage(chatId, NEED_TOKEN_TEXT, MAIN_KEYBOARD);
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

// ---------- مدیریت دکمه‌های شیشه‌ای پنل ادمین ----------
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id })
  });

  if (!adminSessions.has(chatId)) {
    await sendTelegramMessage(chatId, "⛔ ابتدا وارد پنل ادمین شو (/admin).");
    return;
  }

  if (data === "admin_new_token") {
    const token = generateToken();
    db.tokens[token] = { active: true, usedBy: null, createdAt: Date.now() };
    saveData(db);
    await sendTelegramMessage(chatId, `🎫 توکن جدید ساخته شد:\n\n\`${token}\`\n\nاین را برای کاربر مورد نظر بفرست.`);
    return;
  }

  if (data === "admin_list_tokens") {
    await sendTokenList(chatId);
    return;
  }

  if (data === "admin_broadcast") {
    pendingAction.set(chatId, "broadcast_message");
    await sendTelegramMessage(chatId, "📢 متن اعلامیه را بفرست تا برای همه‌ی کاربران ارسال شود:");
    return;
  }

  if (data.startsWith("toggle:")) {
    const token = data.replace("toggle:", "");
    if (db.tokens[token]) {
      db.tokens[token].active = !db.tokens[token].active;
      saveData(db);
    }
    await sendTokenList(chatId);
    return;
  }
}

// پیام اعلامیه را برای همه‌ی کاربران ثبت‌شده ارسال کن
async function broadcastMessage(adminChatId, text) {
  const recipients = db.users;
  let sent = 0;
  let failed = 0;

  await sendTelegramMessage(adminChatId, `⏳ در حال ارسال برای ${recipients.length} کاربر...`);

  for (const userChatId of recipients) {
    try {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userChatId,
          text: `📢 اعلامیه:\n\n${text}`
        })
      });

      const result = await response.json();
      if (result.ok) {
        sent++;
      } else {
        failed++;
      }

      // برای رعایت محدودیت نرخ ارسال تلگرام، کمی بین پیام‌ها فاصله بگذار
      await new Promise(resolve => setTimeout(resolve, 40));

    } catch {
      failed++;
    }
  }

  await sendTelegramMessage(
    adminChatId,
    `✅ اعلامیه ارسال شد.\nموفق: ${sent}\nناموفق: ${failed}`,
    ADMIN_KEYBOARD
  );
}

async function sendTokenList(chatId) {
  const entries = Object.entries(db.tokens);

  if (entries.length === 0) {
    await sendTelegramMessage(chatId, "هنوز هیچ توکنی ساخته نشده.");
    return;
  }

  let text = "📋 لیست توکن‌ها:\n\n";
  const buttons = [];

  for (const [token, info] of entries) {
    const status = info.active ? "🟢 فعال" : "🔴 غیرفعال";
    const owner = info.usedBy ? `استفاده‌شده (${info.usedBy})` : "استفاده‌نشده";
    text += `\`${token}\` — ${status} — ${owner}\n`;

    buttons.push([
      {
        text: `${info.active ? "🔒 غیرفعال کردن" : "🔓 فعال کردن"} ${token}`,
        callback_data: `toggle:${token}`
      }
    ]);
  }

  await sendTelegramMessageWithMarkup(chatId, text, { inline_keyboard: buttons });
}

// ---------- ارسال پیام به تلگرام ----------
async function sendTelegramMessage(chatId, text, keyboard) {
  return sendTelegramMessageWithMarkup(chatId, text, keyboard);
}

async function sendTelegramMessageWithMarkup(chatId, text, markup) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;

    const body = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "Markdown"
    };

    if (isLastChunk && markup) {
      body.reply_markup = markup;
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

app.get("/health", (req, res) => {
  res.send("OK");
});

// لیست دستورات منوی عمومی تلگرام (عمداً /admin در این لیست نیست تا مخفی بماند)
async function setupBotCommands() {
  if (!TELEGRAM_API) return;

  const commands = [
    { command: "start", description: "شروع مجدد ربات" },
    { command: "new", description: "شروع چت جدید" },
    { command: "cancel", description: "لغو مکالمه" },
    { command: "token", description: "وارد کردن توکن دسترسی" },
    { command: "help", description: "راهنما" },
    { command: "about", description: "درباره ربات" }
  ];

  try {
    const response = await fetch(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands })
    });
    console.log("setMyCommands result:", JSON.stringify(await response.json()));

    const menuButtonResponse = await fetch(`${TELEGRAM_API}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } })
    });
    console.log("setChatMenuButton result:", JSON.stringify(await menuButtonResponse.json()));

  } catch (error) {
    console.error("setup commands crashed:", error);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setupBotCommands();
});
