#!/usr/bin/env bun
// Telegram push notifier — polls unread activity and sends a summary via Telegram Bot API.
// Run standalone: bun cron/telegram-push.mjs
// Or schedule via launchd every 30 minutes.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = existsSync(resolve(__dirname, "../config/cozyterm.json"))
  ? resolve(__dirname, "../config/cozyterm.json")
  : resolve(__dirname, "../config/openclaw.json");
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";

// Read bot token from gateway config (same source as gateway)
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    BOT_TOKEN = cfg.channels?.telegram?.botToken;
  } catch (e) {
    console.error("Failed to read gateway config:", e.message);
  }
}

// Default chat ID from paired Telegram DM session
if (!CHAT_ID) {
  try {
    const sessPath = resolve(__dirname, "../config/agents/engie/sessions/sessions.json");
    const sessions = JSON.parse(readFileSync(sessPath, "utf8"));
    for (const sess of Object.values(sessions)) {
      const from = sess.origin?.from;
      if (from?.startsWith("telegram:")) {
        CHAT_ID = from.split(":")[1];
        break;
      }
    }
  } catch {
    // Fall through to error below
  }
}

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Could not resolve Telegram bot token or chat ID");
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars, or ensure gateway config is set up");
  process.exit(1);
}

async function main() {
  // Check unread activity for telegram platform
  const res = await fetch(`${ACTIVITY_URL}/unread?platform=telegram`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    console.error(`Activity server returned ${res.status}`);
    process.exit(1);
  }

  const { unreadCount, latest } = await res.json();

  if (unreadCount === 0) {
    console.log("No unread activity for telegram");
    return;
  }

  // Build summary message
  const platforms = [...new Set(latest.map((i) => i.platform))];
  const lines = [`*${unreadCount} new update${unreadCount !== 1 ? "s" : ""}* from ${platforms.join(", ")}:\n`];

  for (const item of latest.slice(0, 5)) {
    const preview = item.content.slice(0, 100).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
    lines.push(`• _${item.platform}_ \\(${item.role}\\): ${preview}${item.content.length > 100 ? "\\.\\.\\." : ""}`);
  }

  if (unreadCount > 5) {
    lines.push(`\n_\\.\\.\\. and ${unreadCount - 5} more_`);
  }

  const text = lines.join("\n");

  // Send via Telegram Bot API
  const sendRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "MarkdownV2",
      disable_notification: false,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error("Telegram send failed:", err);
    process.exit(1);
  }

  console.log(`Sent ${unreadCount} activity updates to Telegram`);

  // Update cursor to mark as read
  const maxId = Math.max(...latest.map((i) => i.id));
  await fetch(`${ACTIVITY_URL}/cursor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "telegram", last_seen_id: maxId }),
    signal: AbortSignal.timeout(3000),
  });
}

main().catch((err) => {
  console.error("telegram-push error:", err.message);
  process.exit(1);
});
