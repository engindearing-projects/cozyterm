// Forge CLI commands — train, eval, deploy, rollback, status
// Wraps the Python training pipeline from ~/engie/trainer/

import { spawn, execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import {
  getForgeStats,
  getModelVersions,
  getTrainingRuns,
  getLatestEvaluation,
  TRAINER_DIR,
  PYTHON,
} from "./db.js";

const c = {
  accent: chalk.hex("#F4C95D"),
  primary: chalk.hex("#E8A87C"),
  muted: chalk.hex("#9B8B7A"),
  success: chalk.hex("#95C77E"),
  error: chalk.hex("#E07A5F"),
  text: chalk.hex("#F5E6D3"),
  bold: chalk.hex("#FFECD2").bold,
};

function checkPrereqs(): boolean {
  if (!existsSync(TRAINER_DIR)) {
    console.error(c.error("Forge trainer not found at ~/engie/trainer/"));
    return false;
  }
  if (!existsSync(PYTHON)) {
    console.error(c.error("Python venv not found. Run: cd ~/engie/trainer && python -m venv .venv"));
    return false;
  }
  return true;
}

// === cozy forge status ===

export function forgeStatus(): void {
  console.log(c.bold("\n  Forge Status\n"));

  // Trainer DB stats
  const stats = getForgeStats();
  if (!stats) {
    console.log(c.muted("  No Forge DB found. Start training to create it.\n"));
  } else {
    console.log(`  ${c.accent("Training Data")}`);
    console.log(`    Total pairs:  ${c.text(String(stats.totalPairs))}`);
    console.log(`    Unused pairs: ${c.text(String(stats.unusedPairs))}`);
    if (Object.keys(stats.taskTypeCounts).length > 0) {
      const types = Object.entries(stats.taskTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type}: ${count}`)
        .join(", ");
      console.log(`    Task types:   ${c.muted(types)}`);
    }
    console.log();

    console.log(`  ${c.accent("Model")}`);
    console.log(`    Active:       ${stats.activeVersion ? c.success(stats.activeVersion) : c.muted("none")}`);
    console.log(`    Versions:     ${c.text(String(stats.totalVersions))}`);
    console.log(`    Runs:         ${c.text(String(stats.totalRuns))}`);
    if (stats.lastRunVersion) {
      const statusColor = stats.lastRunStatus === "completed" ? c.success : c.error;
      console.log(`    Last run:     ${c.text(stats.lastRunVersion)} ${statusColor(stats.lastRunStatus || "")}`);
    }
    console.log();

    // Latest evaluation
    const eval_ = getLatestEvaluation();
    if (eval_) {
      console.log(`  ${c.accent("Latest Evaluation")} (${eval_.version})`);
      if (eval_.overallScore !== null) console.log(`    Overall:      ${scoreColor(eval_.overallScore)}/100`);
      if (eval_.syntaxScore !== null) console.log(`    Syntax:       ${c.text(eval_.syntaxScore.toFixed(1))}`);
      if (eval_.completenessScore !== null) console.log(`    Completeness: ${c.text(eval_.completenessScore.toFixed(1))}`);
      if (eval_.tasksEvaluated !== null) console.log(`    Tasks:        ${c.text(String(eval_.tasksEvaluated))}`);
      console.log();
    }
  }

  // CozyTerm collector stats
  const collectorDir = join(homedir(), ".cozyterm", "forge");
  if (existsSync(collectorDir)) {
    const files = readdirSync(collectorDir).filter((f) => f.endsWith(".jsonl"));
    let totalPairs = 0;
    let todayPairs = 0;
    const today = new Date().toISOString().split("T")[0];

    for (const f of files) {
      const content = readFileSync(join(collectorDir, f), "utf-8");
      const count = content.trim().split("\n").filter(Boolean).length;
      totalPairs += count;
      if (f.startsWith(today)) todayPairs = count;
    }

    console.log(`  ${c.accent("CozyTerm Collector")}`);
    console.log(`    Today:        ${c.text(String(todayPairs))} pairs`);
    console.log(`    Total files:  ${c.text(String(files.length))} days`);
    console.log(`    Total pairs:  ${c.text(String(totalPairs))}`);
    console.log();
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return c.success(score.toFixed(1));
  if (score >= 60) return c.accent(score.toFixed(1));
  return c.error(score.toFixed(1));
}

// === cozy forge versions ===

export function forgeVersions(): void {
  const versions = getModelVersions();
  if (versions.length === 0) {
    console.log(c.muted("\n  No model versions found.\n"));
    return;
  }

  console.log(c.bold("\n  Model Versions\n"));

  for (const v of versions) {
    const active = v.active ? c.success(" (active)") : "";
    const score = v.benchmarkScore !== null ? `  score: ${scoreColor(v.benchmarkScore)}` : "";
    const tag = v.ollamaTag ? c.muted(` → ${v.ollamaTag}`) : "";

    console.log(`  ${c.text(v.version.padEnd(8))}${active}${score}${tag}`);
    if (v.notes) console.log(`  ${"".padEnd(8)}${c.muted(v.notes)}`);
  }
  console.log();
}

// === cozy forge runs ===

export function forgeRuns(): void {
  const runs = getTrainingRuns(10);
  if (runs.length === 0) {
    console.log(c.muted("\n  No training runs found.\n"));
    return;
  }

  console.log(c.bold("\n  Training Runs\n"));

  for (const r of runs) {
    const statusColor = r.status === "completed" ? c.success : r.status === "failed" ? c.error : c.accent;
    const duration = r.durationSeconds ? `${(r.durationSeconds / 60).toFixed(0)}min` : "";
    const losses = r.trainLoss !== null ? `train: ${r.trainLoss.toFixed(3)} val: ${(r.validLoss || 0).toFixed(3)}` : "";
    const data = r.trainExamples ? `${r.trainExamples}/${r.validExamples} examples` : "";

    console.log(
      `  ${c.text(r.version.padEnd(8))} ${statusColor(r.status.padEnd(10))} ${c.muted(duration.padEnd(8))} ${c.muted(losses)}`,
    );
    if (data) console.log(`  ${"".padEnd(8)} ${c.muted(data)}`);
  }
  console.log();
}

// === cozy forge train ===

export async function forgeTrain(opts: { domain?: string; iters?: number; noResume?: boolean }): Promise<void> {
  if (!checkPrereqs()) return;

  const domain = opts.domain || "coding";
  console.log(c.bold(`\n  Starting training pipeline (${domain})\n`));

  // Check if Ollama needs to be stopped
  try {
    execSync("pgrep -f ollama", { stdio: "ignore" });
    console.log(c.accent("  Stopping Ollama to free GPU memory..."));
    execSync("brew services stop ollama", { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    // Ollama not running, good
  }

  const steps = [
    {
      name: "Prepare data",
      args: ["scripts/prepare-data.py", ...(domain !== "coding" ? ["--domain", domain] : [])],
    },
    {
      name: "Train",
      args: [
        "scripts/train.py",
        ...(domain !== "coding" ? ["--domain", domain] : []),
        ...(opts.iters ? ["--iters", String(opts.iters)] : []),
        ...(opts.noResume ? ["--no-resume"] : []),
      ],
    },
    {
      name: "Fuse & deploy",
      args: ["scripts/fuse-and-deploy.py", ...(domain !== "coding" ? ["--domain", domain] : [])],
    },
    {
      name: "Evaluate",
      args: ["scripts/evaluate.py", ...(domain !== "coding" ? ["--domain", domain] : [])],
    },
  ];

  for (const step of steps) {
    console.log(c.primary(`  [${step.name}]`));
    const ok = await runPython(step.args);
    if (!ok) {
      console.error(c.error(`\n  Training failed at: ${step.name}\n`));
      // Restart Ollama
      try { execSync("brew services start ollama", { stdio: "ignore" }); } catch {}
      return;
    }
    console.log(c.success(`  [${step.name}] done\n`));
  }

  // Restart Ollama
  console.log(c.muted("  Restarting Ollama..."));
  try { execSync("brew services start ollama", { stdio: "ignore" }); } catch {}

  console.log(c.success("\n  Training pipeline complete!\n"));
  forgeStatus();
}

// === cozy forge eval ===

export async function forgeEval(opts: { version?: string; domain?: string }): Promise<void> {
  if (!checkPrereqs()) return;

  const args = [
    "scripts/evaluate.py",
    ...(opts.version ? ["--version", opts.version] : []),
    ...(opts.domain ? ["--domain", opts.domain] : []),
  ];

  console.log(c.bold("\n  Running evaluation\n"));
  const ok = await runPython(args);

  if (ok) {
    console.log(c.success("\n  Evaluation complete.\n"));
    const eval_ = getLatestEvaluation(opts.version);
    if (eval_ && eval_.overallScore !== null) {
      console.log(`  Score: ${scoreColor(eval_.overallScore)}/100\n`);
    }
  } else {
    console.error(c.error("\n  Evaluation failed.\n"));
  }
}

// === cozy forge rollback ===

export function forgeRollback(): void {
  const versions = getModelVersions();
  const active = versions.find((v) => v.active);
  const previous = versions.find((v) => v.deployed && !v.active && v.ollamaTag);

  if (!active) {
    console.error(c.error("No active version found."));
    return;
  }
  if (!previous) {
    console.error(c.error("No previous deployed version to roll back to."));
    return;
  }

  console.log(c.accent(`  Rolling back: ${active.version} → ${previous.version}`));

  try {
    execSync(`ollama cp ${previous.ollamaTag} engie-coder:latest`, { stdio: "inherit" });
    console.log(c.success(`  Rolled back to ${previous.version} (${previous.ollamaTag})\n`));
  } catch (err) {
    console.error(c.error(`  Rollback failed: ${(err as Error).message}`));
  }
}

// Helper — run a Python script from the trainer dir

function runPython(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, args, {
      cwd: TRAINER_DIR,
      stdio: "inherit",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}
