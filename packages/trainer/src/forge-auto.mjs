#!/usr/bin/env bun

// The Forge — Auto-Trainer Daemon
// Watches forge.db for new training pairs and automatically triggers
// the full pipeline: prepare → train → deploy → evaluate → rollback if needed.
//
// Runs as a launchd service (com.engie.forge-auto) or standalone.
// Sends Telegram notifications on train completion or failure.
//
// Usage:
//   bun ~/engie/trainer/forge-auto.mjs [--threshold 100] [--interval 300] [--dry-run]

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINER_DIR = __dirname;
const VENV_PYTHON = resolve(TRAINER_DIR, ".venv", "bin", "python");
const SCRIPTS_DIR = resolve(TRAINER_DIR, "scripts");
const FORGE_DB_PATH = resolve(TRAINER_DIR, "forge-db.js");

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const CONFIG = {
  // Minimum new pairs since last train to trigger
  threshold: parseInt(getArg("threshold", "100")),
  // Check interval in seconds
  intervalSec: parseInt(getArg("interval", "300")),
  // Don't actually train, just log what would happen
  dryRun: args.includes("--dry-run"),
  // Max consecutive failures before pausing
  maxFailures: 3,
  // Minimum hours between training runs
  cooldownHours: 4,
  // Regression threshold — rollback if score drops more than this
  regressionThreshold: 5,
};

let consecutiveFailures = 0;
let lastTrainTime = 0;
let running = false;

// ── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  try {
    const envPath = resolve(dirname(TRAINER_DIR), "config", ".env");
    if (!existsSync(envPath)) return;

    const env = readFileSync(envPath, "utf8");
    const botToken = env.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim();
    const chatId = env.match(/TELEGRAM_CHAT_ID=(.+)/)?.[1]?.trim();
    if (!botToken || !chatId) return;

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // non-fatal
  }
}

// ── Pipeline Steps ──────────────────────────────────────────────────────────

function runScript(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: TRAINER_DIR,
      stdio: opts.quiet ? "pipe" : "inherit",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";
    if (opts.quiet) {
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
    }

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit code ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}

async function getStats() {
  const { getForgeStats, getLastRun, getTotalPairCount } = await import(FORGE_DB_PATH);
  return { stats: getForgeStats(), lastRun: getLastRun(), totalPairs: getTotalPairCount() };
}

async function getNewPairCount() {
  const { getUnusedPairCount } = await import(FORGE_DB_PATH);
  return getUnusedPairCount();
}

async function getActiveScore() {
  const { getActiveVersion, getLatestEvaluation } = await import(FORGE_DB_PATH);
  const active = getActiveVersion();
  if (!active) return null;
  const eval_ = getLatestEvaluation(active.version);
  return eval_?.overall_score ?? active.benchmark_score ?? null;
}

async function runPipeline() {
  const startTime = Date.now();
  const steps = [];

  try {
    // Step 1: Prepare data
    log("Step 1/4: Preparing data...");
    await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "prepare-data.py")]);
    steps.push("prepare ✓");

    // Count training examples
    const trainFile = resolve(TRAINER_DIR, "data", "train.jsonl");
    const trainCount = readFileSync(trainFile, "utf8").trim().split("\n").length;
    log(`  ${trainCount} training examples prepared`);

    // Step 2: Train
    log("Step 2/4: Training LoRA adapter...");
    const scoreBefore = await getActiveScore();
    await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "train.py")]);
    steps.push("train ✓");

    // Step 3: Fuse and deploy
    log("Step 3/4: Fusing and deploying...");
    await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "fuse-and-deploy.py")]);
    steps.push("deploy ✓");

    // Step 4: Evaluate
    log("Step 4/4: Evaluating...");
    try {
      await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "evaluate.py")]);
      steps.push("eval ✓");
    } catch (e) {
      log(`  Evaluation failed (non-fatal): ${e.message}`);
      steps.push("eval ✗");
    }

    // Check for regression
    const scoreAfter = await getActiveScore();
    const duration = ((Date.now() - startTime) / 60000).toFixed(1);

    let message = `🔥 *Forge Training Complete*\n`;
    message += `Steps: ${steps.join(" → ")}\n`;
    message += `Examples: ${trainCount}\n`;
    message += `Duration: ${duration} min\n`;

    if (scoreBefore != null && scoreAfter != null) {
      const delta = scoreAfter - scoreBefore;
      message += `Score: ${scoreBefore.toFixed(1)} → ${scoreAfter.toFixed(1)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})\n`;

      if (delta < -CONFIG.regressionThreshold) {
        log(`REGRESSION detected: ${delta.toFixed(1)} points. Rolling back...`);
        try {
          const { run } = await import(resolve(TRAINER_DIR, "forge-cli.mjs"));
          await run({ args: ["rollback"] });
          message += `⚠️ Regression > ${CONFIG.regressionThreshold}pts — auto-rolled back`;
        } catch (e) {
          message += `⚠️ Regression detected but rollback failed: ${e.message}`;
        }
      }
    }

    // Mark pairs as used
    try {
      const { markPairsUsed, getActiveVersion } = await import(FORGE_DB_PATH);
      const active = getActiveVersion();
      if (active) markPairsUsed(active.version);
    } catch {}

    await sendTelegram(message);
    log(message.replace(/[*_]/g, ""));

    consecutiveFailures = 0;
    lastTrainTime = Date.now();
    return true;
  } catch (e) {
    consecutiveFailures++;
    const message = `❌ *Forge Training Failed*\nStep: ${steps.join(" → ")}\nError: ${e.message.slice(0, 200)}\nFailures: ${consecutiveFailures}/${CONFIG.maxFailures}`;
    await sendTelegram(message);
    log(message.replace(/[*_]/g, ""));
    return false;
  }
}

// ── Main Loop ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function check() {
  if (running) return;

  // Check cooldown
  const hoursSinceLast = (Date.now() - lastTrainTime) / 3600000;
  if (hoursSinceLast < CONFIG.cooldownHours) {
    return;
  }

  // Check failure limit
  if (consecutiveFailures >= CONFIG.maxFailures) {
    log(`Paused: ${consecutiveFailures} consecutive failures. Restart to reset.`);
    return;
  }

  // Check new pair count
  const newPairs = await getNewPairCount();
  if (newPairs < CONFIG.threshold) {
    return;
  }

  log(`Threshold met: ${newPairs} new pairs (threshold: ${CONFIG.threshold})`);

  if (CONFIG.dryRun) {
    log("DRY RUN — would start training pipeline");
    return;
  }

  running = true;
  try {
    await runPipeline();
  } finally {
    running = false;
  }
}

async function main() {
  log("=== The Forge — Auto-Trainer Daemon ===");
  log(`  Threshold:    ${CONFIG.threshold} new pairs`);
  log(`  Check every:  ${CONFIG.intervalSec}s`);
  log(`  Cooldown:     ${CONFIG.cooldownHours}h between runs`);
  log(`  Rollback at:  -${CONFIG.regressionThreshold}pts regression`);
  log(`  Dry run:      ${CONFIG.dryRun}`);
  log("");

  // Initial check
  const newPairs = await getNewPairCount();
  log(`Current unused pairs: ${newPairs}`);

  // Run check loop
  const interval = setInterval(check, CONFIG.intervalSec * 1000);

  // Initial check after a short delay
  setTimeout(check, 5000);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log("Received SIGTERM, shutting down...");
    clearInterval(interval);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log("Received SIGINT, shutting down...");
    clearInterval(interval);
    process.exit(0);
  });
}

// Allow import for testing
export { runPipeline, check, CONFIG };

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
