#!/usr/bin/env bun

// The Forge — Standalone CLI
// Can be run directly: bun ~/engie/trainer/forge-cli.mjs <command>
// Or via engie: engie forge <command>

import chalk from "chalk";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINER_DIR = __dirname;
const VENV_PYTHON = resolve(TRAINER_DIR, ".venv", "bin", "python");
const SCRIPTS_DIR = resolve(TRAINER_DIR, "scripts");

const HELP = `
  ${chalk.bold("engie forge")} — The Forge training pipeline

  ${chalk.cyan("Commands:")}
    init [--domain id]  Set up The Forge (venv, model, directories, DB)
    status              Show training data, model versions, and scores
    domain [id]         List domains or switch active domain
    train               Run full pipeline: prepare → train → evaluate → deploy
    serve               Start the model serving API for external access
    eval                Run benchmark on current model
    iterate             Self-iteration: run model on benchmarks, fix until tests pass
    compare "prompt"    Side-by-side Claude vs engie-coder
    data                Collection stats
    mine                Run expanded data miner (distillation pairs)
    mine-gt             Run ground-truth miner (real merged diffs)
    mine-top            Mine top-starred GitHub repos (ground-truth)
    auto [start|stop]   Manage auto-trainer daemon
    rollback            Revert to previous model version

  ${chalk.cyan("Examples:")}
    engie forge init
    engie forge init --domain healthcare
    engie forge status
    engie forge train
    engie forge serve
    engie forge iterate --model hermes3:8b --max-iters 5
    engie forge mine-gt --sources MarekHealth,vercel --max-prs 5
    engie forge mine-top --langs js,py,go --max-repos 20 --max-prs 3
    engie forge auto start
    engie forge compare "Write a fibonacci function in Python"
`;

function ensureVenv() {
  if (!existsSync(VENV_PYTHON)) {
    console.error(chalk.red("Python venv not found. Run setup first:"));
    console.error(chalk.dim("  bash ~/engie/trainer/setup.sh"));
    process.exit(1);
  }
}

function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(VENV_PYTHON, [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdInit(args) {
  const { execSync, spawnSync } = await import("child_process");
  const { mkdirSync, writeFileSync } = await import("fs");

  // Parse --domain flag
  let domainId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) domainId = args[i + 1];
  }

  console.log(chalk.bold("\n  The Forge — Setup\n"));

  // Step 1: Detect hardware
  console.log(chalk.cyan("  Step 1: Detecting hardware..."));
  const arch = process.arch; // arm64 = Apple Silicon, x64 = Intel/AMD
  const platform = process.platform;
  let accelerator = "cpu";

  if (platform === "darwin" && arch === "arm64") {
    accelerator = "mlx";
    console.log(`    Platform:     macOS Apple Silicon (${arch})`);
    console.log(`    Accelerator:  MLX (Metal GPU)`);
  } else if (platform === "linux") {
    // Check for NVIDIA GPU
    try {
      const nvOut = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null", { encoding: "utf8" });
      accelerator = "cuda";
      console.log(`    Platform:     Linux ${arch}`);
      console.log(`    Accelerator:  CUDA (${nvOut.trim()})`);
    } catch {
      console.log(`    Platform:     Linux ${arch}`);
      console.log(`    Accelerator:  CPU only (no NVIDIA GPU detected)`);
    }
  } else {
    console.log(`    Platform:     ${platform} ${arch}`);
    console.log(`    Accelerator:  CPU only`);
  }

  // Step 2: Check prerequisites
  console.log(chalk.cyan("\n  Step 2: Checking prerequisites..."));

  // Python
  const pythonCandidates = [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
  let pythonPath = null;
  for (const p of pythonCandidates) {
    try {
      const ver = execSync(`${p} --version 2>&1`, { encoding: "utf8" }).trim();
      pythonPath = p;
      console.log(`    Python:       ${ver} (${p})`);
      break;
    } catch {}
  }
  if (!pythonPath) {
    console.error(chalk.red("    Python 3 not found. Install it first:"));
    console.error(chalk.dim("      macOS:  brew install python@3.14"));
    console.error(chalk.dim("      Linux:  sudo apt install python3 python3-venv"));
    process.exit(1);
  }

  // Ollama
  let ollamaOk = false;
  try {
    const ollamaVer = execSync("ollama --version 2>&1", { encoding: "utf8" }).trim();
    ollamaOk = true;
    console.log(`    Ollama:       ${ollamaVer}`);
  } catch {
    console.log(chalk.yellow("    Ollama:       not found (needed for model deployment)"));
    console.log(chalk.dim("      Install:  https://ollama.com/download"));
  }

  // Bun
  try {
    const bunVer = execSync("bun --version 2>&1", { encoding: "utf8" }).trim();
    console.log(`    Bun:          ${bunVer}`);
  } catch {
    console.log(chalk.yellow("    Bun:          not found (needed for forge CLI)"));
  }

  // llama.cpp (for GGUF quantization)
  let llamaCppOk = false;
  try {
    execSync("which llama-quantize 2>/dev/null", { encoding: "utf8" });
    llamaCppOk = true;
    console.log(`    llama.cpp:    installed`);
  } catch {
    console.log(chalk.dim("    llama.cpp:    not found (optional, for GGUF quantization)"));
    console.log(chalk.dim("      macOS:  brew install llama.cpp"));
    console.log(chalk.dim("      Linux:  build from source or use pre-built binaries"));
  }

  // Step 3: Create directories
  console.log(chalk.cyan("\n  Step 3: Creating directories..."));
  const dirs = [
    "data/raw", "data/traces",
    "models/base", "models/adapters", "models/fused", "models/gguf",
    "benchmarks/results",
    "db", "logs", "domains",
  ];
  for (const d of dirs) {
    const full = resolve(TRAINER_DIR, d);
    mkdirSync(full, { recursive: true });
  }
  console.log(`    Created ${dirs.length} directories`);

  // Step 4: Set up Python venv
  console.log(chalk.cyan("\n  Step 4: Setting up Python environment..."));
  const venvDir = resolve(TRAINER_DIR, ".venv");

  if (!existsSync(resolve(venvDir, "bin", "python"))) {
    console.log("    Creating virtual environment...");
    try {
      execSync(`${pythonPath} -m venv "${venvDir}"`, { stdio: "inherit" });
    } catch (err) {
      console.error(chalk.red(`    Failed to create venv: ${err.message}`));
      process.exit(1);
    }
  } else {
    console.log("    Virtual environment already exists");
  }

  console.log("    Installing dependencies...");
  const pipCmd = `"${venvDir}/bin/pip" install --upgrade pip --quiet && "${venvDir}/bin/pip" install -r "${resolve(TRAINER_DIR, "requirements.txt")}" --quiet`;
  try {
    execSync(pipCmd, { stdio: "inherit", shell: true });
  } catch (err) {
    console.error(chalk.red(`    Dependency install failed: ${err.message}`));
    console.error(chalk.dim("    Try manually: source trainer/.venv/bin/activate && pip install -r trainer/requirements.txt"));
    process.exit(1);
  }

  // Verify mlx-lm (only on Apple Silicon)
  if (accelerator === "mlx") {
    try {
      const mlxVer = execSync(`"${venvDir}/bin/python" -c "import mlx_lm; print(mlx_lm.__version__)"`, { encoding: "utf8", shell: true }).trim();
      console.log(`    mlx-lm:       ${mlxVer}`);
    } catch {
      console.log(chalk.yellow("    mlx-lm:       install failed (needed for training on Apple Silicon)"));
    }
  }

  // Step 5: Download base model
  console.log(chalk.cyan("\n  Step 5: Base model..."));
  const { getActiveDomain, setActiveDomain, loadDomain } = await import("./domain-config.mjs");

  // Set domain if requested
  if (domainId) {
    try {
      setActiveDomain(domainId);
      console.log(`    Active domain set to: ${domainId}`);
    } catch (err) {
      console.error(chalk.red(`    Invalid domain: ${err.message}`));
    }
  }

  const domain = getActiveDomain();
  const baseModelName = domain.base_model || "Qwen2.5-Coder-7B-Instruct-4bit";
  const baseModelDir = resolve(TRAINER_DIR, "models", "base", baseModelName);

  if (existsSync(resolve(baseModelDir, "config.json"))) {
    console.log(`    Base model already downloaded: ${baseModelName}`);
  } else if (accelerator === "mlx") {
    console.log(`    Downloading ${baseModelName} via mlx_lm.convert...`);
    console.log(chalk.dim("    This will take a few minutes (downloading ~4GB)..."));
    try {
      execSync(
        `"${venvDir}/bin/python" -m mlx_lm convert --hf-path Qwen/Qwen2.5-Coder-7B-Instruct --mlx-path "${baseModelDir}" -q`,
        { stdio: "inherit", shell: true, cwd: TRAINER_DIR },
      );
      console.log(chalk.green("    Base model downloaded."));
    } catch (err) {
      console.error(chalk.yellow(`    Model download failed: ${err.message}`));
      console.error(chalk.dim("    You can download it later: engie forge init"));
    }
  } else {
    console.log(chalk.yellow(`    Skipping base model download (MLX only — ${accelerator} platform)`));
    console.log(chalk.dim("    For CUDA: download the HuggingFace model manually or use a GGUF"));
  }

  // Step 6: Initialize forge DB
  console.log(chalk.cyan("\n  Step 6: Initializing database..."));
  try {
    const { getForgeStats } = await import("./forge-db.js");
    const stats = getForgeStats();
    console.log(`    DB ready: ${stats.totalPairs} pairs, ${stats.totalVersions} versions`);
  } catch (err) {
    console.error(chalk.yellow(`    DB init warning: ${err.message}`));
  }

  // Step 7: Check for llama.cpp convert script
  const convertScript = resolve(TRAINER_DIR, "tools", "llama.cpp", "convert_hf_to_gguf.py");
  if (!existsSync(convertScript)) {
    console.log(chalk.cyan("\n  Step 7: GGUF conversion tools..."));
    console.log(chalk.dim("    llama.cpp convert script not found."));
    console.log(chalk.dim("    For proper GGUF quantization, run:"));
    console.log(chalk.dim("      git clone --depth 1 https://github.com/ggml-org/llama.cpp.git trainer/tools/llama.cpp"));
  }

  // Summary
  console.log(chalk.green("\n  Setup complete!\n"));
  console.log(`  Domain:       ${domain.name} (${domain.id})`);
  console.log(`  Model prefix: ${domain.model_prefix}`);
  console.log(`  Accelerator:  ${accelerator}`);
  console.log(`  Venv:         ${venvDir}`);
  if (ollamaOk) console.log(`  Ollama:       ready`);
  console.log("");
  console.log(chalk.cyan("  Next steps:"));
  console.log("    1. Collect training data through the proxy or miners");
  console.log("    2. Run training: engie forge train");
  console.log("    3. Evaluate:     engie forge eval");
  console.log("    4. Serve:        engie forge serve");
  console.log("");
}

async function cmdServe(args) {
  console.log(chalk.bold("\n  Starting The Forge Serving API...\n"));
  const script = resolve(TRAINER_DIR, "serve.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Serve exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function cmdDomain(domainId) {
  const { listDomains, setActiveDomain, getActiveDomainId } = await import("./domain-config.mjs");

  if (domainId) {
    // Switch domain
    try {
      setActiveDomain(domainId);
      console.log(chalk.green(`\n  Active domain set to: ${domainId}\n`));
    } catch (err) {
      console.error(chalk.red(`  ${err.message}`));
      process.exit(1);
    }
  }

  // List all domains
  const domains = listDomains();
  console.log(chalk.bold("\n  The Forge — Domains\n"));
  for (const d of domains) {
    const marker = d.active ? chalk.green("→") : " ";
    console.log(`  ${marker} ${d.id.padEnd(14)} ${d.name.padEnd(25)} ${chalk.dim(d.model_prefix)}`);
  }
  console.log(chalk.dim(`\n  Switch: engie forge domain <id>`));
  console.log("");
}

async function cmdStatus() {
  const { getForgeStats, getAllVersions, getLastRun } = await import("./forge-db.js");
  const { getActiveDomain } = await import("./domain-config.mjs");
  const stats = getForgeStats();
  const domain = getActiveDomain();

  console.log(chalk.bold("\n  The Forge — Status\n"));
  console.log(chalk.cyan("  Domain:"));
  console.log(`    Active:        ${domain.name} (${domain.id})`)
  console.log(`    Model prefix:  ${domain.model_prefix}`);

  // Data
  console.log(chalk.cyan("  Data Collection:"));
  console.log(`    Total pairs:   ${stats.totalPairs}`);
  console.log(`    Unused pairs:  ${stats.unusedPairs}`);

  // Check raw files
  const rawDir = resolve(TRAINER_DIR, "data", "raw");
  if (existsSync(rawDir)) {
    const files = readdirSync(rawDir).filter((f) => f.endsWith(".jsonl"));
    console.log(`    Raw files:     ${files.length}`);
    if (files.length > 0) {
      const latest = files.sort().pop();
      console.log(`    Latest file:   ${latest}`);
    }
  }

  // Training
  console.log(chalk.cyan("\n  Training:"));
  console.log(`    Total runs:    ${stats.totalRuns}`);
  if (stats.lastRun) {
    console.log(`    Last run:      ${stats.lastRun.version} (${stats.lastRun.status})`);
    if (stats.lastRun.train_loss) {
      console.log(`    Train loss:    ${stats.lastRun.train_loss.toFixed(4)}`);
      console.log(`    Valid loss:    ${stats.lastRun.valid_loss?.toFixed(4) ?? "n/a"}`);
    }
  }

  // Model versions
  console.log(chalk.cyan("\n  Model Versions:"));
  console.log(`    Total:         ${stats.totalVersions}`);
  if (stats.activeVersion) {
    console.log(`    Active:        ${stats.activeVersion.version}`);
    if (stats.activeVersion.benchmark_score != null) {
      console.log(`    Benchmark:     ${stats.activeVersion.benchmark_score.toFixed(1)}%`);
    }
  } else {
    console.log(`    Active:        ${chalk.dim("(none — run first training)")}`);
  }

  console.log("");
}

async function cmdTrain() {
  ensureVenv();
  console.log(chalk.bold("\n  The Forge — Training Pipeline\n"));

  // Step 1: Prepare data
  console.log(chalk.cyan("  Step 1: Preparing data..."));
  try {
    await runPython(resolve(SCRIPTS_DIR, "prepare-data.py"));
  } catch (err) {
    console.error(chalk.red(`  Data preparation failed: ${err.message}`));
    process.exit(1);
  }

  // Check if we have enough data
  const trainFile = resolve(TRAINER_DIR, "data", "train.jsonl");
  if (!existsSync(trainFile)) {
    console.error(chalk.red("  No training data generated. Collect more pairs first."));
    process.exit(1);
  }
  const trainLines = readFileSync(trainFile, "utf8").trim().split("\n").length;
  console.log(chalk.green(`  Prepared ${trainLines} training examples`));

  // Step 2: Train
  console.log(chalk.cyan("\n  Step 2: Training LoRA adapter..."));
  try {
    await runPython(resolve(SCRIPTS_DIR, "train.py"));
  } catch (err) {
    console.error(chalk.red(`  Training failed: ${err.message}`));
    process.exit(1);
  }

  // Step 3: Fuse and deploy
  console.log(chalk.cyan("\n  Step 3: Fusing and deploying..."));
  try {
    await runPython(resolve(SCRIPTS_DIR, "fuse-and-deploy.py"));
  } catch (err) {
    console.error(chalk.red(`  Deployment failed: ${err.message}`));
    process.exit(1);
  }

  // Step 4: Evaluate the deployed model
  console.log(chalk.cyan("\n  Step 4: Evaluating deployed model..."));
  try {
    await runPython(resolve(SCRIPTS_DIR, "evaluate.py"));
  } catch (err) {
    console.error(chalk.yellow(`  Evaluation failed: ${err.message} (non-fatal)`));
  }

  console.log(chalk.green("\n  Training pipeline complete!"));
  await cmdStatus();
}

async function cmdEval() {
  ensureVenv();
  console.log(chalk.bold("\n  The Forge — Evaluation\n"));
  await runPython(resolve(SCRIPTS_DIR, "evaluate.py"));
}

async function cmdCompare(prompt) {
  if (!prompt) {
    console.error(chalk.red("Usage: engie forge compare \"your prompt here\""));
    process.exit(1);
  }

  console.log(chalk.bold("\n  The Forge — Side-by-Side Comparison\n"));
  console.log(chalk.dim(`  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`));
  console.log("");

  // Call both in parallel
  const [claudeResult, localResult] = await Promise.all([
    fetchClaude(prompt),
    fetchOllama(prompt),
  ]);

  console.log(chalk.cyan("  ─── Claude ───"));
  console.log(claudeResult.response || chalk.dim("  (no response)"));
  console.log(chalk.dim(`  Duration: ${claudeResult.durationMs}ms`));

  console.log("");
  console.log(chalk.yellow("  ─── engie-coder ───"));
  console.log(localResult.response || chalk.dim("  (no response)"));
  console.log(chalk.dim(`  Duration: ${localResult.durationMs}ms`));

  // Save as training pair if both responded
  if (claudeResult.response && localResult.response &&
      !claudeResult.response.startsWith("Error") && !localResult.response.startsWith("Error")) {
    try {
      const { Collector } = await import("./collector.mjs");
      const c = new Collector();
      const { createHash, randomUUID } = await import("crypto");
      const { appendFileSync } = await import("fs");
      const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
      const pair = {
        id: `pair_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        timestamp: new Date().toISOString(),
        prompt,
        prompt_hash: promptHash,
        complexity_score: null,
        routed_to: "compare",
        claude_response: claudeResult.response,
        claude_duration_ms: claudeResult.durationMs,
        local_response: localResult.response,
        local_duration_ms: localResult.durationMs,
        local_model: "engie-coder:latest",
      };
      const date = new Date().toISOString().slice(0, 10);
      const rawFile = resolve(TRAINER_DIR, "data", "raw", `${date}.jsonl`);
      appendFileSync(rawFile, JSON.stringify(pair) + "\n");

      const { recordPair } = await import("./forge-db.js");
      recordPair({
        id: pair.id,
        prompt_hash: promptHash,
        timestamp: pair.timestamp,
        complexity_score: null,
        routed_to: "compare",
        claude_response_length: claudeResult.response.length,
        local_response_length: localResult.response.length,
        claude_duration_ms: claudeResult.durationMs,
        local_duration_ms: localResult.durationMs,
        local_model: "engie-coder:latest",
        has_code: /```/.test(claudeResult.response),
      });
      console.log(chalk.green(`  Pair saved to data/raw/${date}.jsonl`));
    } catch (err) {
      console.log(chalk.dim(`  (pair save failed: ${err.message})`));
    }
  }
  console.log("");
}

async function fetchClaude(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch("http://127.0.0.1:18791/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: "sonnet" }),
    });
    const data = await resp.json();
    const text = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    return { response: text, durationMs: Date.now() - start };
  } catch (err) {
    return { response: `Error: ${err.message}`, durationMs: Date.now() - start };
  }
}

async function fetchOllama(prompt) {
  const { getActiveDomain } = await import("./domain-config.mjs");
  const domain = getActiveDomain();
  const model = `${domain.model_prefix}:latest`;
  const start = Date.now();
  try {
    const resp = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: domain.system_prompt },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
    });
    const data = await resp.json();
    return { response: data.message?.content ?? null, durationMs: Date.now() - start };
  } catch (err) {
    return { response: `Error: ${err.message}`, durationMs: Date.now() - start };
  }
}

async function cmdData() {
  const { getTotalPairCount, getUnusedPairCount } = await import("./forge-db.js");
  const rawDir = resolve(TRAINER_DIR, "data", "raw");
  const tracesDir = resolve(TRAINER_DIR, "data", "traces");

  console.log(chalk.bold("\n  The Forge — Collection Stats\n"));

  const total = getTotalPairCount();
  const unused = getUnusedPairCount();
  console.log(chalk.cyan("  Distillation Pairs:"));
  console.log(`    DB total:        ${total}`);
  console.log(`    DB unused:       ${unused}`);
  console.log(`    DB trained:      ${total - unused}`);

  if (existsSync(rawDir)) {
    const files = readdirSync(rawDir).filter((f) => f.endsWith(".jsonl")).sort();
    console.log(`    Raw files:       ${files.length}`);
    for (const f of files.slice(-5)) {
      const path = resolve(rawDir, f);
      const lines = readFileSync(path, "utf8").trim().split("\n").length;
      const size = (statSync(path).size / 1024).toFixed(1);
      console.log(`      ${f}  ${lines} pairs  ${size}KB`);
    }
  }

  // Trace stats
  if (existsSync(tracesDir)) {
    const traceFiles = readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl")).sort();
    if (traceFiles.length > 0) {
      let totalTraces = 0;
      let toolTraces = 0;
      let siTraces = 0;
      let siSuccessful = 0;

      for (const f of traceFiles) {
        const path = resolve(tracesDir, f);
        const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            totalTraces++;
            if (f.includes("-tools.")) toolTraces++;
            if (f.includes("-self-iterate.")) {
              siTraces++;
              if (rec.success) siSuccessful++;
            }
          } catch {}
        }
      }

      console.log(chalk.cyan("\n  Traces:"));
      console.log(`    Total traces:    ${totalTraces}`);
      console.log(`    Tool-use:        ${toolTraces}`);
      console.log(`    Self-iterate:    ${siTraces} (${siSuccessful} successful)`);
      console.log(`    Trace files:     ${traceFiles.length}`);
      for (const f of traceFiles.slice(-5)) {
        const path = resolve(tracesDir, f);
        const size = (statSync(path).size / 1024).toFixed(1);
        console.log(`      ${f}  ${size}KB`);
      }
    }
  }

  console.log("");
}

async function cmdRollback() {
  const { getAllVersions, setActiveVersion, getActiveVersion } = await import("./forge-db.js");
  const versions = getAllVersions();

  if (versions.length < 2) {
    console.error(chalk.red("Not enough versions to rollback"));
    process.exit(1);
  }

  const current = getActiveVersion();
  const previous = versions.find((v) => v.version !== current?.version && v.deployed);

  if (!previous) {
    console.error(chalk.red("No previous deployed version found"));
    process.exit(1);
  }

  console.log(chalk.bold("\n  The Forge — Rollback\n"));
  console.log(`  Current:  ${current?.version ?? "none"}`);
  console.log(`  Rolling back to: ${previous.version}`);

  // Update Ollama to point to the previous version
  if (previous.ollama_tag) {
    const { execSync } = await import("child_process");
    try {
      execSync(`ollama cp ${previous.ollama_tag} engie-coder:latest`, { stdio: "inherit" });
      setActiveVersion(previous.version);
      console.log(chalk.green(`\n  Rolled back to ${previous.version}`));
    } catch (err) {
      console.error(chalk.red(`  Rollback failed: ${err.message}`));
      process.exit(1);
    }
  } else {
    console.error(chalk.red("  Previous version has no Ollama tag"));
    process.exit(1);
  }
}

async function cmdAuto(action) {
  const { execSync } = await import("child_process");
  const svc = "com.engie.forge-auto";
  const plist = `${process.env.HOME}/Library/LaunchAgents/${svc}.plist`;

  if (action === "start") {
    try {
      execSync(`launchctl bootout gui/$(id -u) ${plist} 2>/dev/null`, { stdio: "pipe" });
    } catch {}
    try {
      execSync(`launchctl bootstrap gui/$(id -u) ${plist}`, { stdio: "inherit" });
      console.log(chalk.green(`\n  Auto-trainer started (${svc})`));
      console.log(chalk.dim(`  Logs: ~/engie/trainer/logs/forge-auto.log`));
    } catch (e) {
      console.error(chalk.red(`  Failed to start: ${e.message}`));
    }
  } else if (action === "stop") {
    try {
      execSync(`launchctl bootout gui/$(id -u) ${plist}`, { stdio: "inherit" });
      console.log(chalk.green(`\n  Auto-trainer stopped`));
    } catch (e) {
      console.error(chalk.red(`  Failed to stop: ${e.message}`));
    }
  } else {
    // Status
    let running = false;
    try {
      const out = execSync(`launchctl print gui/$(id -u)/${svc} 2>&1`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      running = /state = running/i.test(out) || !(/state = not running/i.test(out));
    } catch {}

    console.log(chalk.bold("\n  The Forge — Auto-Trainer\n"));
    console.log(`  Service:  ${svc}`);
    console.log(`  Status:   ${running ? chalk.green("running") : chalk.dim("stopped")}`);
    console.log(`  Plist:    ${plist}`);
    console.log(chalk.dim(`\n  engie forge auto start   — start daemon`));
    console.log(chalk.dim(`  engie forge auto stop    — stop daemon`));
    console.log("");
  }
}

async function cmdIterate(args) {
  console.log(chalk.bold("\n  The Forge — Self-Iteration\n"));
  console.log(chalk.dim("  Running model through benchmarks with test-feedback loop...\n"));
  const script = resolve(TRAINER_DIR, "self-iterate.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Self-iteration exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function cmdMine(args) {
  console.log(chalk.bold("\n  The Forge — Expanded Data Miner\n"));
  console.log(chalk.dim("  Running mine-expanded.mjs in foreground...\n"));
  const script = resolve(TRAINER_DIR, "mine-expanded.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Miner exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function cmdMineGT(args) {
  console.log(chalk.bold("\n  The Forge — Ground-Truth Data Miner\n"));
  console.log(chalk.dim("  Mining real merged PR diffs as gold standard...\n"));
  const script = resolve(TRAINER_DIR, "mine-ground-truth.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Ground-truth miner exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function cmdMineTop(args) {
  console.log(chalk.bold("\n  The Forge — Top Repos Ground-Truth Miner\n"));
  console.log(chalk.dim("  Mining merged PRs from top-starred GitHub repos...\n"));
  const script = resolve(TRAINER_DIR, "mine-top-repos.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, ...args], {
      cwd: TRAINER_DIR,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Top repos miner exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function run({ args = [] } = {}) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case "init":
      return cmdInit(args.slice(1));
    case "status":
      return cmdStatus();
    case "serve":
      return cmdServe(args.slice(1));
    case "domain":
      return cmdDomain(args[1]);
    case "train":
      return cmdTrain();
    case "eval":
      return cmdEval();
    case "iterate":
      return cmdIterate(args.slice(1));
    case "compare":
      return cmdCompare(args.slice(1).join(" "));
    case "data":
      return cmdData();
    case "mine":
      return cmdMine(args.slice(1));
    case "mine-gt":
      return cmdMineGT(args.slice(1));
    case "mine-top":
      return cmdMineTop(args.slice(1));
    case "auto":
      return cmdAuto(args[1]);
    case "rollback":
      return cmdRollback();
    default:
      console.error(chalk.red(`Unknown forge command: ${sub}`));
      console.log(HELP);
      process.exit(1);
  }
}

// Allow direct execution
if (import.meta.main) {
  run({ args: process.argv.slice(2) }).catch((err) => {
    console.error(chalk.red(err.message));
    process.exit(1);
  });
}
