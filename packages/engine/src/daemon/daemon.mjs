#!/usr/bin/env bun
// Background daemon — autonomous investigation + Telegram approval + execution.
//
// Connects to the gateway as a WebSocket client, evaluates local triggers on a 60s tick,
// investigates via gateway, proposes actions via Telegram inline buttons, and executes
// approved items.
//
// Key principle: investigate freely, act only with approval.

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { GatewayClient, loadConfig } from "../cli/src/gateway.mjs";
import { findConfig } from "../cli/lib/paths.js";
import { evaluateTriggers } from "../shared/trigger-cascade.js";
import {
  createWorkItem, updateWorkItem, getWorkItem,
  getItemsByStatus, getDeferredItems, timeoutStaleApprovals,
} from "../shared/work-queue.js";
import {
  sendApprovalRequest, updateApprovalMessage, tgSendDirect, isTelegramConfigured,
} from "./daemon-telegram.mjs";
import { DAEMON_SESSION_KEY, DAEMON_COOLDOWN_MS, DEFAULT_ACTIVITY_PORT } from "../shared/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

const TICK_INTERVAL_MS = 60 * 1000;        // 60 seconds
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_YIELD_MS = 5 * 60 * 1000;    // yield if CLI active in last 5 min
const GATEWAY_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per gateway call
const SANITY_CHECK_TIMEOUT_MS = 30 * 1000; // 30s for Claude proxy
const ACTIVITY_URL = process.env.ACTIVITY_URL || `http://localhost:${DEFAULT_ACTIVITY_PORT}`;
const CLAUDE_PROXY_URL = process.env.CLAUDE_PROXY_URL || "http://localhost:18791";

let gateway = null;
let lastActionTime = 0;
let tickTimer = null;

// ── Gateway Connection ─────────────────────────────────────────────────────

async function waitForGateway(maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch("http://localhost:18789/health", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  return false;
}

async function connectGateway() {
  const configPath = findConfig();
  if (!configPath) throw new Error("No gateway config found");

  const { port, token } = loadConfig(configPath);
  if (!token) throw new Error("No gateway auth token in config");

  gateway = new GatewayClient({ port, token });

  gateway.on("error", (err) => {
    console.error("[daemon] Gateway error:", err.message);
  });

  gateway.on("disconnected", () => {
    console.log("[daemon] Gateway disconnected — will reconnect on next tick");
    gateway = null;
  });

  await gateway.connect();
  console.log("[daemon] Connected to gateway");
}

async function ensureGateway() {
  if (gateway?.connected) return true;

  try {
    await connectGateway();
    return true;
  } catch (e) {
    console.error("[daemon] Failed to connect to gateway:", e.message);
    return false;
  }
}

// ── Gateway Chat ───────────────────────────────────────────────────────────

/**
 * Send a message to the gateway and wait for the full response.
 * Accumulates streaming text from agent events until chat.state === "final".
 */
function sendAndWaitForResponse(sessionKey, message) {
  return new Promise((resolve, reject) => {
    if (!gateway?.connected) {
      reject(new Error("Gateway not connected"));
      return;
    }

    let accumulated = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Gateway response timed out"));
    }, GATEWAY_RESPONSE_TIMEOUT_MS);

    function onAgent(payload) {
      if (payload.sessionKey !== sessionKey) return;
      if (payload.stream === "assistant" && payload.data?.delta) {
        accumulated += payload.data.delta;
      }
    }

    function onChat(payload) {
      if (payload.sessionKey !== sessionKey) return;
      if (payload.state === "final") {
        cleanup();
        // Prefer the final message content over accumulated stream
        const text = payload.message?.content || accumulated;
        resolve(typeof text === "string" ? text : JSON.stringify(text));
      }
    }

    function cleanup() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      gateway.removeListener("agent", onAgent);
      gateway.removeListener("chat", onChat);
    }

    gateway.on("agent", onAgent);
    gateway.on("chat", onChat);

    // Send the message (fire-and-forget, streaming begins via events)
    gateway.chat(sessionKey, message).catch((e) => {
      cleanup();
      reject(e);
    });
  });
}

// ── Session Awareness ──────────────────────────────────────────────────────

/**
 * Check if the CLI TUI is currently active (user interacting).
 * Queries the activity server for recent CLI activity.
 */
async function isUserActive() {
  try {
    const res = await fetch(`${ACTIVITY_URL}/activity?limit=5`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;

    const { items } = await res.json();
    if (!items || items.length === 0) return false;

    // Check for recent TUI/CLI activity
    const now = Date.now();
    for (const item of items) {
      const isCliActivity = item.session_key?.startsWith("agent:engie:cli") ||
                            item.platform === "tui";
      if (!isCliActivity) continue;

      const age = now - new Date(item.created_at).getTime();
      if (age < SESSION_YIELD_MS) return true;
    }
    return false;
  } catch {
    return false; // If activity server is down, don't block
  }
}

// ── Investigation ──────────────────────────────────────────────────────────

/**
 * Investigate a work item — send an investigation prompt to the gateway,
 * parse findings, and decide whether action is needed.
 */
async function investigateItem(item) {
  updateWorkItem(item.id, { status: "investigating" });
  console.log(`[daemon] Investigating: ${item.trigger_type} — ${item.prompt.slice(0, 80)}...`);

  try {
    // Step 1: Investigate (read-only)
    const investigationPrompt = `[daemon-investigate] ${item.prompt}

Important: This is a background investigation. Do NOT take any actions — only gather information and report findings. Summarize what you find in 2-3 sentences.`;

    const findings = await sendAndWaitForResponse(DAEMON_SESSION_KEY, investigationPrompt);

    updateWorkItem(item.id, { findings });

    // Step 2: Ask if action is needed
    const decisionPrompt = `[daemon-decide] Based on these findings:

${findings}

Should any action be taken? If yes, respond in this exact format:
ACTION: <one-line description of what to do>
RISK: low|medium|high
COMMAND: <the prompt to send to execute the action>

If no action is needed, respond with just: NO_ACTION`;

    const decision = await sendAndWaitForResponse(DAEMON_SESSION_KEY, decisionPrompt);

    // Parse the decision
    if (decision.includes("NO_ACTION") || !decision.includes("ACTION:")) {
      updateWorkItem(item.id, { status: "done", execution_result: "No action needed" });
      console.log(`[daemon] No action needed for ${item.id.slice(0, 8)}`);
      return;
    }

    const actionMatch = decision.match(/ACTION:\s*(.+)/);
    const riskMatch = decision.match(/RISK:\s*(low|medium|high)/i);
    const commandMatch = decision.match(/COMMAND:\s*(.+)/s);

    const proposedAction = actionMatch?.[1]?.trim() || "Review findings";
    const riskLevel = (riskMatch?.[1] || "low").toLowerCase();
    const proposedCommand = commandMatch?.[1]?.trim() || "";

    updateWorkItem(item.id, {
      proposed_action: proposedAction,
      proposed_command: proposedCommand,
      risk_level: riskLevel,
      status: "proposed",
    });

    // Step 3: Send Telegram approval request
    if (isTelegramConfigured()) {
      try {
        const { message_id, chat_id } = await sendApprovalRequest(item.id, {
          trigger: item.trigger_type,
          action: proposedAction,
          findings: findings.slice(0, 300),
          risk: riskLevel,
        });
        updateWorkItem(item.id, { approval_msg_id: message_id, approval_chat_id: chat_id });
        console.log(`[daemon] Approval request sent for ${item.id.slice(0, 8)}`);
      } catch (e) {
        console.error("[daemon] Failed to send Telegram approval:", e.message);
      }
    } else {
      console.log(`[daemon] Telegram not configured — item ${item.id.slice(0, 8)} proposed but no approval channel`);
    }
  } catch (e) {
    console.error(`[daemon] Investigation error for ${item.id.slice(0, 8)}:`, e.message);
    updateWorkItem(item.id, { status: "error", error: e.message });
  }
}

// ── Execution ──────────────────────────────────────────────────────────────

/**
 * Claude Code sanity check — ask the proxy to review the proposed action.
 * This is a safety net for the first week of daemon operation.
 */
async function claudeSanityCheck(proposedAction, findings) {
  try {
    const res = await fetch(CLAUDE_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `Review this proposed daemon action for safety and correctness. The daemon wants to execute this autonomously after user approval. Flag any issues.

Proposed action: ${proposedAction}
Context/findings: ${findings || "none"}

Respond in this format:
SAFE: yes|no
CONCERNS: <comma-separated list, or "none">`,
      }),
      signal: AbortSignal.timeout(SANITY_CHECK_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.log("[daemon] Claude proxy returned non-OK, skipping sanity check");
      return { safe: true, concerns: [] };
    }

    const result = await res.text();
    const safeMatch = result.match(/SAFE:\s*(yes|no)/i);
    const concernsMatch = result.match(/CONCERNS:\s*(.+)/i);

    const safe = safeMatch?.[1]?.toLowerCase() !== "no";
    const concerns = concernsMatch?.[1]?.trim() === "none" ? [] :
      (concernsMatch?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) || []);

    return { safe, concerns };
  } catch (e) {
    // If proxy is down or times out, skip check and proceed
    console.log(`[daemon] Sanity check skipped (${e.message}), proceeding`);
    return { safe: true, concerns: [] };
  }
}

/**
 * Execute an approved work item via the gateway.
 */
async function executeApprovedItem(item) {
  updateWorkItem(item.id, { status: "executing" });
  const shortId = item.id.slice(0, 8);
  console.log(`[daemon] Executing approved item ${shortId}: ${item.proposed_action}`);

  try {
    // Claude sanity check (safety layer)
    const { safe, concerns } = await claudeSanityCheck(item.proposed_action, item.findings);

    if (!safe) {
      console.log(`[daemon] Claude flagged concerns for ${shortId}:`, concerns);
      updateWorkItem(item.id, { status: "proposed" });

      if (isTelegramConfigured() && item.approval_chat_id) {
        const concernText = concerns.length > 0 ? concerns.join(", ") : "unspecified safety concerns";
        await tgSendDirect(item.approval_chat_id,
          `⚠️ Claude reviewed [${shortId}] and flagged concerns: ${concernText}\n\nPlease re-review the proposal above.`
        );
      }
      return;
    }

    // Execute the action via gateway
    const command = item.proposed_command || item.proposed_action;
    const executionPrompt = `[daemon-execute] Execute this approved action:\n\n${command}`;

    const result = await sendAndWaitForResponse(DAEMON_SESSION_KEY, executionPrompt);

    updateWorkItem(item.id, {
      status: "done",
      execution_result: result.slice(0, 2000),
    });

    lastActionTime = Date.now();
    console.log(`[daemon] Completed ${shortId}`);

    // Notify via Telegram
    if (isTelegramConfigured()) {
      try {
        const summary = result.length > 300 ? result.slice(0, 297) + "..." : result;
        await tgSendDirect(item.approval_chat_id || null,
          `✅ Executed [${shortId}]: ${item.proposed_action}\n\nResult: ${summary}`
        );
      } catch (e) {
        console.error("[daemon] Failed to send execution notification:", e.message);
      }
    }
  } catch (e) {
    console.error(`[daemon] Execution error for ${shortId}:`, e.message);
    updateWorkItem(item.id, { status: "error", error: e.message });

    if (isTelegramConfigured()) {
      try {
        await tgSendDirect(item.approval_chat_id || null,
          `❌ Execution failed [${shortId}]: ${e.message}`
        );
      } catch { /* best effort */ }
    }
  }
}

// ── Tick Loop ──────────────────────────────────────────────────────────────

async function tick() {
  try {
    // 1. Timeout stale approvals (2h)
    const timedOut = timeoutStaleApprovals(APPROVAL_TIMEOUT_MS);
    if (timedOut > 0) console.log(`[daemon] Timed out ${timedOut} stale proposals`);

    // 2. Re-queue deferred items whose timer has expired
    const deferred = getDeferredItems();
    for (const item of deferred) {
      updateWorkItem(item.id, { status: "pending", defer_until: null });
      console.log(`[daemon] Re-queued deferred item ${item.id.slice(0, 8)}`);
    }

    // 3. Check for approved items — execute them first (highest priority)
    const approved = getItemsByStatus("approved", 1);
    if (approved.length > 0) {
      if (!await ensureGateway()) return;
      await executeApprovedItem(approved[0]);
      return; // One action per tick
    }

    // 4. Cooldown check — don't investigate too frequently after an action
    if (Date.now() - lastActionTime < DAEMON_COOLDOWN_MS) {
      return;
    }

    // 5. Session awareness — yield to active CLI sessions
    if (await isUserActive()) {
      return;
    }

    // 6. Check if we already have items being investigated or proposed
    const investigating = getItemsByStatus("investigating", 1);
    if (investigating.length > 0) return; // Already working on something

    const proposed = getItemsByStatus("proposed", 5);
    if (proposed.length >= 3) return; // Too many pending approvals, don't pile on

    // 7. Evaluate triggers
    const trigger = evaluateTriggers();
    if (!trigger) return;

    // 8. Deduplicate — skip if we recently investigated the same trigger type
    const recentSame = getItemsByStatus("done", 10)
      .filter((i) => i.trigger_type === trigger.trigger);
    if (recentSame.length > 0) {
      const lastDone = new Date(recentSame[0].updated_at).getTime();
      const hourAgo = Date.now() - 60 * 60 * 1000;
      if (lastDone > hourAgo) return; // Investigated same trigger within the hour
    }

    // 9. Create work item and investigate
    if (!await ensureGateway()) return;

    const itemId = createWorkItem({
      trigger_type: trigger.trigger,
      prompt: trigger.prompt,
    });

    const item = getWorkItem(itemId);
    await investigateItem(item);
  } catch (e) {
    console.error("[daemon] Tick error:", e.message);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("[daemon] Starting background daemon...");
  console.log(`[daemon] Session key: ${DAEMON_SESSION_KEY}`);
  console.log(`[daemon] Cooldown: ${DAEMON_COOLDOWN_MS / 1000}s`);
  console.log(`[daemon] Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`[daemon] Telegram configured: ${isTelegramConfigured()}`);

  // Wait for gateway to be available
  console.log("[daemon] Waiting for gateway...");
  const gatewayUp = await waitForGateway();
  if (!gatewayUp) {
    console.error("[daemon] Gateway did not become available within 60s");
    process.exit(1);
  }

  // Initial connection
  try {
    await connectGateway();
  } catch (e) {
    console.error("[daemon] Initial gateway connection failed:", e.message);
    console.log("[daemon] Will retry on first tick");
  }

  // Start tick loop
  console.log("[daemon] Starting tick loop");
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  // Run first tick after a short delay
  setTimeout(tick, 5000);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[daemon] SIGTERM received, shutting down...");
    clearInterval(tickTimer);
    gateway?.disconnect();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("[daemon] SIGINT received, shutting down...");
    clearInterval(tickTimer);
    gateway?.disconnect();
    process.exit(0);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("[daemon] Fatal:", e.message);
  process.exit(1);
});
