// Telegram helpers for the background daemon — approval requests, message updates, notifications.
// Uses the same bot token resolution pattern as telegram-bridge.mjs and cron/telegram-push.mjs.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { findConfig } from "../cli/lib/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

const CONFIG_PATH = findConfig() || (
  existsSync(resolve(PROJECT_DIR, "config", "cozyterm.json"))
    ? resolve(PROJECT_DIR, "config", "cozyterm.json")
    : resolve(PROJECT_DIR, "config", "openclaw.json")
);

// Resolve bot token and default chat ID
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BRIDGE_TOKEN;
let DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  BOT_TOKEN = BOT_TOKEN || cfg.channels?.telegram?.botToken;
} catch { /* config not available */ }

// Try to resolve chat ID from sessions if not in env
if (!DEFAULT_CHAT_ID) {
  try {
    const sessPath = resolve(PROJECT_DIR, "config/agents/engie/sessions/sessions.json");
    const sessions = JSON.parse(readFileSync(sessPath, "utf8"));
    for (const sess of Object.values(sessions)) {
      const from = sess.origin?.from;
      if (from?.startsWith("telegram:")) {
        DEFAULT_CHAT_ID = from.split(":")[1];
        break;
      }
    }
  } catch { /* no sessions file */ }
}

const RISK_EMOJI = { low: "🟢", medium: "🟡", high: "🔴" };

/**
 * Call a Telegram Bot API method.
 */
async function tgCall(method, body) {
  if (!BOT_TOKEN) throw new Error("No Telegram bot token configured");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result;
}

/**
 * Send a plain text notification.
 * @param {string} chatId
 * @param {string} text
 */
export async function tgSendDirect(chatId, text) {
  const targetChat = chatId || DEFAULT_CHAT_ID;
  if (!targetChat) throw new Error("No chat ID available");

  // Truncate if needed (Telegram limit is 4096)
  const trimmed = text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  return tgCall("sendMessage", {
    chat_id: targetChat,
    text: trimmed,
    disable_web_page_preview: true,
  });
}

/**
 * Send an approval request with inline keyboard buttons.
 * @param {string} workItemId - Work item UUID
 * @param {{ trigger: string, action: string, findings: string, risk: string }} details
 * @param {string} [chatId] - Override chat ID
 * @returns {number} The message_id for tracking button responses
 */
export async function sendApprovalRequest(workItemId, { trigger, action, findings, risk = "low" }, chatId) {
  const targetChat = chatId || DEFAULT_CHAT_ID;
  if (!targetChat) throw new Error("No chat ID available");

  const emoji = RISK_EMOJI[risk] || "🟢";
  const shortId = workItemId.slice(0, 8);

  const text = [
    `${emoji} *Daemon proposal* [${shortId}]`,
    ``,
    `*Trigger:* ${trigger}`,
    `*Findings:* ${findings || "—"}`,
    ``,
    `*Proposed action:* ${action}`,
    `*Risk:* ${risk}`,
  ].join("\n");

  const result = await tgCall("sendMessage", {
    chat_id: targetChat,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `daemon:approve:${workItemId}` },
        { text: "⏭ Skip", callback_data: `daemon:skip:${workItemId}` },
        { text: "⏰ Defer 1h", callback_data: `daemon:defer:${workItemId}` },
      ]],
    },
  });

  return { message_id: result.message_id, chat_id: targetChat };
}

/**
 * Edit an existing approval message (e.g., after user responds).
 * @param {string} chatId
 * @param {number} messageId
 * @param {string} newText
 */
export async function updateApprovalMessage(chatId, messageId, newText) {
  try {
    await tgCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: newText,
      parse_mode: "Markdown",
    });
  } catch (e) {
    // Non-fatal — message may already be deleted or too old
    console.error("Failed to update approval message:", e.message);
  }
}

/**
 * Answer a callback query (Telegram requires this within 10s of button press).
 * @param {string} callbackQueryId
 * @param {string} [text] - Optional toast text shown to user
 */
export async function answerCallbackQuery(callbackQueryId, text) {
  await tgCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
  });
}

/**
 * Check if Telegram is configured (has bot token + chat ID).
 */
export function isTelegramConfigured() {
  return Boolean(BOT_TOKEN && DEFAULT_CHAT_ID);
}

export { DEFAULT_CHAT_ID, BOT_TOKEN };
