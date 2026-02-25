#!/usr/bin/env bun

// CozyTerm — AI coding agent for the terminal
// Usage:
//   cozy                    Interactive TUI (multi-model)
//   cozy "fix the bug"      One-shot mode
//   cozy --provider multi   Multi-model (default)
//   cozy --provider ollama  Single Ollama model
//   cozy --plan             Start in planner mode
//   cozy models             Show model assignments

import { program } from "commander";
import { render } from "ink";
import React from "react";
import { loadConfig } from "../src/config/config.js";
import { createRouter } from "../src/providers/router.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { MultiModelProvider, DEFAULT_ROLES } from "../src/providers/multi-model.js";
import { createCoderAgent } from "../src/agents/coder.js";
import { createPlannerAgent } from "../src/agents/planner.js";
import { ForgeCollector } from "@cozyterm/trainer/src/collector.js";
import { LSPManager } from "../src/lsp/manager.js";
import { InteractivePermissionManager } from "../src/permissions/manager.js";
import { loadMCPTools, type MCPConfig } from "../src/mcp/client.js";
import { App } from "../src/tui/App.js";
import { loadCustomCommands, resolveCommand, listCommands } from "../src/commands/loader.js";
import { writeAgentsMd } from "../src/commands/agents-md.js";
import {
  forgeStatus,
  forgeVersions,
  forgeRuns,
  forgeTrain,
  forgeEval,
  forgeRollback,
} from "@cozyterm/trainer/src/commands.js";
import type { Provider } from "../src/providers/types.js";
import type { PermissionManager, Tool } from "../src/tools/types.js";
import chalk from "chalk";

// Import themes so they register
import "../src/tui/themes/cozyterm.js";
import "../src/tui/themes/dracula.js";
import "../src/tui/themes/tokyonight.js";

program
  .name("cozy")
  .description("AI coding agent for the terminal")
  .version("2.0.0");

// Main command — run agent
program
  .argument("[prompt...]", "One-shot prompt (runs agent and exits)")
  .option("-p, --provider <name>", "Provider: multi, ollama, anthropic, auto")
  .option("-m, --model <name>", "Model override (single-model mode)")
  .option("--plan", "Start in planner (read-only) mode")
  .option("--theme <name>", "TUI theme: cozyterm, dracula, tokyonight")
  .option("--no-forge", "Disable Forge training data collection")
  .option("--no-lsp", "Disable LSP language servers")
  .option("--yes", "Auto-allow all tool permissions")
  .option("--max-turns <n>", "Maximum agent turns", "50")
  .action(async (promptParts: string[], opts) => {
    const config = loadConfig();
    const cwd = process.cwd();

    // Apply CLI overrides
    if (opts.provider) config.provider = opts.provider;
    if (opts.theme) config.tui.theme = opts.theme;
    if (opts.forge === false) config.forge.enabled = false;

    // If --model is passed, force single-model mode
    if (opts.model) {
      config.provider = "ollama";
      config.ollama.model = opts.model;
    }

    const maxTurns = parseInt(opts.maxTurns) || config.agent.maxTurns;

    // Resolve provider
    const provider = await resolveProvider(config);

    // Start LSP servers (auto-detect project languages)
    let lsp: LSPManager | undefined;
    if (opts.lsp !== false) {
      lsp = new LSPManager(cwd);
      const started = await lsp.autoStart();
      if (started.length > 0) {
        console.error(chalk.hex("#9B8B7A")(`  LSP: ${started.join(", ")}`));
      }
    }

    // Load MCP tools from config
    let mcpTools: Tool[] = [];
    const mcpConfig = config as unknown as MCPConfig;
    if (mcpConfig.mcpServers) {
      const { tools, servers } = await loadMCPTools(mcpConfig);
      mcpTools = tools;
      if (servers.length > 0) {
        console.error(chalk.hex("#9B8B7A")(`  MCP: ${servers.join(", ")}`));
      }
    }

    // Permission manager
    const permissions: PermissionManager = opts.yes
      ? InteractivePermissionManager.autoAllow()
      : InteractivePermissionManager.autoAllow(); // TUI handles interactive perms internally

    let prompt = promptParts.join(" ").trim();

    // Resolve custom commands (/review, /test, etc.)
    if (prompt.startsWith("/")) {
      const commands = loadCustomCommands(cwd);
      const resolved = resolveCommand(prompt, commands);
      if (resolved) {
        console.error(chalk.hex("#9B8B7A")(`  command: /${resolved.command.name}`));
        prompt = resolved.prompt;
      }
    }

    if (prompt) {
      await runOneShot(provider, cwd, permissions, prompt, opts.plan, maxTurns, config, lsp, mcpTools);
    } else {
      // Interactive TUI mode
      render(
        React.createElement(App, {
          provider,
          cwd,
          themeName: config.tui.theme,
          forgeEnabled: config.forge.enabled,
          maxTurns,
          lsp,
          mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
          permissions,
        }),
      );
    }
  });

// Models subcommand — show model assignments and availability
program
  .command("models")
  .description("Show model assignments per role")
  .action(async () => {
    const config = loadConfig();
    const host = config.ollama.host;

    console.log(chalk.hex("#E8A87C").bold("\n  CozyTerm Models\n"));

    const roles = {
      orchestrator: { model: config.models.orchestrator, desc: "Tool calling & agent loop" },
      coder: { model: config.models.coder, desc: "Code generation & editing" },
      reasoner: { model: config.models.reasoner, desc: "Analysis, planning, debugging" },
      chat: { model: config.models.chat, desc: "Conversation & quick answers" },
    };

    // Check what's available in Ollama
    const installed = await OllamaProvider.discover(host);

    for (const [role, info] of Object.entries(roles)) {
      const available = installed.some(
        (m) => m === info.model || m.startsWith(info.model.split(":")[0]),
      );
      const status = available
        ? chalk.hex("#95C77E")("ready")
        : chalk.hex("#E07A5F")("not found");

      console.log(
        `  ${chalk.hex("#F4C95D")(role.padEnd(14))} ${chalk.hex("#F5E6D3")(info.model.padEnd(28))} ${status}`,
      );
      console.log(`  ${"".padEnd(14)} ${chalk.hex("#9B8B7A")(info.desc)}`);
      console.log();
    }

    if (installed.length > 0) {
      console.log(chalk.hex("#9B8B7A")(`  Ollama: ${installed.length} models at ${host}`));
    } else {
      console.log(chalk.hex("#E07A5F")(`  Ollama not running at ${host}`));
    }
    console.log();
  });

// Forge subcommands
const forge = program.command("forge").description("Model training and management");

forge
  .command("status")
  .description("Show training stats, model versions, and collection data")
  .action(() => forgeStatus());

forge
  .command("versions")
  .description("List all model versions with benchmark scores")
  .action(() => forgeVersions());

forge
  .command("runs")
  .description("Show recent training runs")
  .action(() => forgeRuns());

forge
  .command("train")
  .description("Run full training pipeline (prepare → train → deploy → eval)")
  .option("-d, --domain <name>", "Training domain (default: coding)")
  .option("-i, --iters <n>", "Training iterations")
  .option("--no-resume", "Start training from scratch")
  .action(async (opts) => {
    await forgeTrain({
      domain: opts.domain,
      iters: opts.iters ? parseInt(opts.iters) : undefined,
      noResume: opts.resume === false,
    });
  });

forge
  .command("eval")
  .description("Evaluate a model version against benchmarks")
  .option("-v, --version <v>", "Version to evaluate (default: active)")
  .option("-d, --domain <name>", "Domain (default: coding)")
  .action(async (opts) => {
    await forgeEval({ version: opts.version, domain: opts.domain });
  });

forge
  .command("rollback")
  .description("Roll back to the previous model version")
  .action(() => forgeRollback());

// Custom commands subcommand
program
  .command("commands")
  .description("List available custom commands")
  .action(() => {
    const cwd = process.cwd();
    const commands = loadCustomCommands(cwd);
    if (commands.length === 0) {
      console.log(chalk.hex("#9B8B7A")("\n  No custom commands found."));
      console.log(chalk.hex("#9B8B7A")("  Create .cozyterm/commands/review.md to add one.\n"));
    } else {
      console.log(chalk.hex("#E8A87C").bold("\n  Custom Commands\n"));
      console.log(listCommands(commands));
      console.log();
    }
  });

// Init subcommand — generate AGENTS.md
program
  .command("init")
  .description("Analyze project and generate AGENTS.md")
  .action(async () => {
    const cwd = process.cwd();
    console.log(chalk.hex("#9B8B7A")("  Analyzing project..."));
    const outPath = await writeAgentsMd(cwd);
    console.log(chalk.hex("#95C77E")(`  Generated ${outPath}`));
  });

// Engine subcommands — manage the always-on brain
const engine = program.command("engine").description("Manage the CozyTerm engine (always-on brain)");

engine
  .command("start")
  .description("Start the engine daemon")
  .action(async () => {
    const { execSync } = await import("child_process");
    const { homedir } = await import("os");
    const plistName = "com.cozyterm.engine";
    const plistPath = `${homedir()}/Library/LaunchAgents/${plistName}.plist`;

    try {
      // Check if plist is installed
      const { existsSync } = await import("fs");
      if (!existsSync(plistPath)) {
        console.log(chalk.hex("#F4C95D")("  Engine service not installed. Run: cozy engine install"));
        return;
      }
      execSync(`launchctl load -w ${plistPath}`, { stdio: "pipe" });
      console.log(chalk.hex("#95C77E")("  Engine started"));
    } catch (err) {
      // Already loaded — try kickstart
      try {
        execSync(`launchctl kickstart -k gui/$(id -u)/${plistName}`, { stdio: "pipe" });
        console.log(chalk.hex("#95C77E")("  Engine restarted"));
      } catch {
        console.log(chalk.hex("#E07A5F")(`  Failed to start engine: ${(err as Error).message}`));
      }
    }
  });

engine
  .command("stop")
  .description("Stop the engine daemon")
  .action(async () => {
    const { execSync } = await import("child_process");
    const { homedir } = await import("os");
    const plistPath = `${homedir()}/Library/LaunchAgents/com.cozyterm.engine.plist`;
    try {
      execSync(`launchctl unload ${plistPath}`, { stdio: "pipe" });
      console.log(chalk.hex("#9B8B7A")("  Engine stopped"));
    } catch {
      console.log(chalk.hex("#9B8B7A")("  Engine is not running"));
    }
  });

engine
  .command("status")
  .description("Check if the engine is running")
  .action(async () => {
    const { execSync } = await import("child_process");
    try {
      const result = execSync("launchctl list | grep com.cozyterm.engine", { encoding: "utf-8" });
      const parts = result.trim().split(/\s+/);
      const pid = parts[0];
      if (pid && pid !== "-") {
        console.log(chalk.hex("#95C77E")(`  Engine running (PID ${pid})`));
      } else {
        console.log(chalk.hex("#F4C95D")("  Engine loaded but not running"));
      }
    } catch {
      console.log(chalk.hex("#9B8B7A")("  Engine is not running"));
    }
  });

engine
  .command("logs")
  .description("Tail engine logs")
  .option("-n, --lines <n>", "Number of lines", "50")
  .action(async (opts) => {
    const { spawn } = await import("child_process");
    const { homedir } = await import("os");
    const logFile = `${homedir()}/.cozyterm/logs/engine.log`;
    console.log(chalk.hex("#9B8B7A")(`  Tailing ${logFile}\n`));
    const tail = spawn("tail", ["-f", "-n", opts.lines, logFile], { stdio: "inherit" });
    tail.on("error", () => {
      console.log(chalk.hex("#E07A5F")("  No engine logs found. Is the engine running?"));
    });
  });

engine
  .command("install")
  .description("Install the engine as a launchd service")
  .action(async () => {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { homedir } = await import("os");
    const { join } = await import("path");

    const home = homedir();
    const agentsDir = join(home, "Library", "LaunchAgents");
    const logDir = join(home, ".cozyterm", "logs");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    // Find the engine daemon script
    const daemonPath = join(process.cwd(), "packages", "engine", "src", "daemon", "daemon.mjs");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cozyterm.engine</string>
  <key>ProgramArguments</key>
  <array>
    <string>${home}/.bun/bin/bun</string>
    <string>run</string>
    <string>${daemonPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/engine.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/engine.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${home}/.bun/bin</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
</dict>
</plist>`;

    const plistPath = join(agentsDir, "com.cozyterm.engine.plist");
    writeFileSync(plistPath, plist);
    console.log(chalk.hex("#95C77E")(`  Installed engine service to ${plistPath}`));
    console.log(chalk.hex("#9B8B7A")("  Run: cozy engine start"));
  });

async function resolveProvider(config: ReturnType<typeof loadConfig>): Promise<Provider> {
  const host = config.ollama.host;

  // Multi-model mode — the default
  if (config.provider === "multi") {
    const installed = await OllamaProvider.discover(host);
    if (installed.length > 0) {
      const multiProvider = new MultiModelProvider(host, {
        orchestrator: { model: config.models.orchestrator, temperature: 0.3 },
        coder: { model: config.models.coder, temperature: 0.7 },
        reasoner: { model: config.models.reasoner, temperature: 0.4 },
        chat: { model: config.models.chat, temperature: 0.7 },
      });

      // Check availability and warn about missing models
      const { missing } = await MultiModelProvider.checkAvailability(
        host,
        {
          orchestrator: { model: config.models.orchestrator },
          coder: { model: config.models.coder },
          reasoner: { model: config.models.reasoner },
          chat: { model: config.models.chat },
        },
      );

      if (missing.length > 0) {
        for (const m of missing) {
          console.error(
            chalk.hex("#F4C95D")(`  warning: ${m.role} model "${m.model}" not found in Ollama`),
          );
        }
      }

      return multiProvider;
    }

    // Ollama not available — fall through to cloud
    if (process.env.ANTHROPIC_API_KEY) {
      console.error(chalk.hex("#F4C95D")("  Ollama not available, falling back to Anthropic"));
      return new AnthropicProvider(config.anthropic.model);
    }

    console.error(chalk.red("No provider available. Start Ollama or set ANTHROPIC_API_KEY."));
    process.exit(1);
  }

  // Auto mode — smart routing between local and cloud
  if (config.provider === "auto") {
    const models = await OllamaProvider.discover(host);
    if (models.length > 0) {
      const router = createRouter(config);
      return router.local;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return new AnthropicProvider(config.anthropic.model);
    }
    console.error(chalk.red("No provider available."));
    process.exit(1);
  }

  // Explicit single-provider modes
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider(host, config.ollama.model);
    case "anthropic":
      return new AnthropicProvider(config.anthropic.model);
    default:
      return new OllamaProvider(host, config.ollama.model);
  }
}

async function runOneShot(
  provider: Provider,
  cwd: string,
  permissions: PermissionManager,
  prompt: string,
  planMode: boolean,
  maxTurns: number,
  config: ReturnType<typeof loadConfig>,
  lsp?: LSPManager,
  mcpTools?: Tool[],
): Promise<void> {
  const startTime = Date.now();
  const collector = new ForgeCollector(config.forge.enabled);

  const modeLabel = planMode ? "plan" : "coder";
  const isMulti = provider instanceof MultiModelProvider;

  console.log(
    chalk.hex("#9B8B7A")(
      isMulti
        ? `[multi-model] (${modeLabel})`
        : `[${provider.name}/${provider.model}] (${modeLabel})`,
    ),
  );

  const agent = planMode
    ? createPlannerAgent(provider, cwd, permissions, maxTurns, lsp)
    : createCoderAgent(provider, cwd, permissions, maxTurns, lsp, mcpTools);

  // Show tool activity
  agent.on("tool_start", (name, args) => {
    const detail =
      name === "bash"
        ? `$ ${args.command}`
        : name === "read_file"
          ? args.path
          : name === "glob"
            ? args.pattern
            : name === "grep"
              ? args.pattern
              : "";

    // Show which model is active if multi-model
    const modelTag = isMulti
      ? chalk.hex("#6B5D4E")(` (${(provider as MultiModelProvider).currentRole})`)
      : "";

    console.log(chalk.hex("#6B5D4E")(`  [${name}] ${detail}`) + modelTag);
  });

  agent.on("tool_end", (name, result) => {
    if (result.error) {
      console.log(chalk.hex("#E07A5F")(`  [${name}] ERROR: ${result.error}`));
    }
  });

  try {
    const result = await agent.run(prompt);
    console.log("");
    console.log(result);

    // Collect for training
    collector.wrapRun(
      provider.name,
      provider.model,
      cwd,
      planMode
        ? ["read_file", "glob", "grep"]
        : ["read_file", "edit_file", "write_file", "bash", "glob", "grep"],
      agent.history,
      agent.tokenUsage,
      Date.now() - startTime,
    );
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

program.parse();
