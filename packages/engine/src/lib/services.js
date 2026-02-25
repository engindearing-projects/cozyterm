// Service lifecycle management for CozyTerm launchd services.
// All paths resolved dynamically — no hardcoded user paths.

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { engieHome, logsDir } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Code repo root (~/engie/) — distinct from data home (~/.cozyterm/) */
const REPO_ROOT = resolve(__dirname, "../..");

const HOME = process.env.HOME || "/tmp";
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const DOMAIN_TARGET = `gui/${process.getuid()}`;

/**
 * Returns service definitions for all managed services.
 * Paths are resolved dynamically at call time.
 */
export function getServiceDefs() {
  const root = engieHome();
  const logs = logsDir();

  return [
    {
      label: "com.cozyterm.gateway",
      displayName: "Gateway",
      healthUrl: "http://localhost:18789/health",
      plistPath: join(LAUNCH_AGENTS_DIR, "com.cozyterm.gateway.plist"),
      logPath: join(logs, "gateway.log"),
      errorLogPath: join(logs, "gateway.err.log"),
      managed: true,
    },
    {
      label: "com.cozyterm.claude-proxy",
      displayName: "Claude Proxy",
      healthUrl: "http://localhost:18791/health",
      plistPath: join(LAUNCH_AGENTS_DIR, "com.cozyterm.claude-proxy.plist"),
      logPath: join(logs, "claude-proxy.log"),
      errorLogPath: join(logs, "claude-proxy.error.log"),
      managed: true,
    },
    {
      label: "homebrew.mxcl.ollama",
      displayName: "Ollama",
      healthUrl: "http://localhost:11434/",
      plistPath: join(LAUNCH_AGENTS_DIR, "homebrew.mxcl.ollama.plist"),
      logPath: join(HOME, ".ollama", "logs", "server.log"),
      errorLogPath: null,
      managed: false, // managed by homebrew, we only observe
    },
  ];
}

/**
 * Check if a launchd service is loaded and running.
 * Returns { running: bool, pid: number|null }
 */
export function checkServiceRunning(label) {
  try {
    const output = execSync(`launchctl list`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const line of output.split("\n")) {
      if (line.includes(label)) {
        const parts = line.trim().split(/\s+/);
        const pidStr = parts[0];
        const pid = pidStr === "-" ? null : parseInt(pidStr, 10);
        return { running: pid !== null, pid };
      }
    }
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

/**
 * HTTP health check with timeout.
 * Returns { healthy: bool, latencyMs: number }
 */
export async function checkServiceHealth(url) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    return { healthy: res.ok, latencyMs };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}

/**
 * Full status for a single service (running + health).
 */
export async function getServiceStatus(def) {
  const { running, pid } = checkServiceRunning(def.label);
  let healthy = false;
  let latencyMs = 0;

  if (running) {
    const health = await checkServiceHealth(def.healthUrl);
    healthy = health.healthy;
    latencyMs = health.latencyMs;
  }

  return {
    label: def.label,
    displayName: def.displayName,
    running,
    healthy,
    pid,
    latencyMs,
    managed: def.managed,
  };
}

/**
 * Status for all services.
 */
export async function getAllServicesStatus() {
  const defs = getServiceDefs();
  return Promise.all(defs.map((d) => getServiceStatus(d)));
}

/**
 * Generate plist XML for a service definition.
 * All paths resolved dynamically.
 */
function generateGatewayPlist() {
  const logs = logsDir();
  const scriptPath = resolve(REPO_ROOT, "scripts", "start-gateway.sh");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cozyterm.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(logs, "gateway.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(logs, "gateway.err.log")}</string>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>`;
}

function generateClaudeProxyPlist() {
  const logs = logsDir();
  const scriptsDir = resolve(REPO_ROOT, "scripts");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cozyterm.claude-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>claude-code-proxy.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${scriptsDir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROXY_PORT</key>
        <string>18791</string>
        <key>CLAUDE_PROXY_MODEL</key>
        <string>sonnet</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(logs, "claude-proxy.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(logs, "claude-proxy.error.log")}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
}

/**
 * Install (or reinstall) a managed service plist and bootstrap it.
 */
export function installService(def) {
  if (!def.managed) {
    throw new Error(`${def.displayName} is not managed by CozyTerm — install via homebrew`);
  }

  let plistContent;
  if (def.label === "com.cozyterm.gateway") {
    plistContent = generateGatewayPlist();
  } else if (def.label === "com.cozyterm.claude-proxy") {
    plistContent = generateClaudeProxyPlist();
  } else {
    throw new Error(`No plist generator for ${def.label}`);
  }

  // Bootout first if already loaded
  try {
    execSync(`launchctl bootout ${DOMAIN_TARGET}/${def.label} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    // Not loaded — fine
  }

  writeFileSync(def.plistPath, plistContent, "utf-8");

  execSync(`launchctl bootstrap ${DOMAIN_TARGET} ${def.plistPath}`, {
    encoding: "utf-8",
    timeout: 10000,
  });
}

/**
 * Restart a managed service via kickstart -k.
 */
export function restartService(label) {
  const def = getServiceDefs().find((d) => d.label === label);
  if (!def) throw new Error(`Unknown service: ${label}`);
  if (!def.managed) {
    // For non-managed (ollama), use brew
    try {
      execSync("brew services restart ollama", { encoding: "utf-8", timeout: 30000 });
      return;
    } catch (e) {
      throw new Error(`Failed to restart ollama via brew: ${e.message}`);
    }
  }

  try {
    execSync(`launchctl kickstart -k ${DOMAIN_TARGET}/${label}`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    // If kickstart fails, try bootout + bootstrap
    try {
      execSync(`launchctl bootout ${DOMAIN_TARGET}/${label} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // Might not be loaded
    }
    if (existsSync(def.plistPath)) {
      execSync(`launchctl bootstrap ${DOMAIN_TARGET} ${def.plistPath}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } else {
      installService(def);
    }
  }
}

/**
 * Start a single service. Installs plist if missing.
 */
export function startService(label) {
  const def = getServiceDefs().find((d) => d.label === label);
  if (!def) throw new Error(`Unknown service: ${label}`);

  if (!def.managed) {
    try {
      execSync("brew services start ollama", { encoding: "utf-8", timeout: 30000 });
      return;
    } catch (e) {
      throw new Error(`Failed to start ollama via brew: ${e.message}`);
    }
  }

  const { running } = checkServiceRunning(label);
  if (running) return; // already running

  if (!existsSync(def.plistPath)) {
    installService(def);
  } else {
    try {
      execSync(`launchctl bootstrap ${DOMAIN_TARGET} ${def.plistPath}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // Might already be bootstrapped but not running — kickstart
      execSync(`launchctl kickstart ${DOMAIN_TARGET}/${label}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    }
  }
}

/**
 * Stop a single service.
 */
export function stopService(label) {
  const def = getServiceDefs().find((d) => d.label === label);
  if (!def) throw new Error(`Unknown service: ${label}`);

  if (!def.managed) {
    try {
      execSync("brew services stop ollama", { encoding: "utf-8", timeout: 30000 });
      return;
    } catch (e) {
      throw new Error(`Failed to stop ollama via brew: ${e.message}`);
    }
  }

  try {
    execSync(`launchctl bootout ${DOMAIN_TARGET}/${label}`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    // Might not be loaded — fine
  }
}

/**
 * Start all managed services, then ollama.
 */
export function startAllServices() {
  const defs = getServiceDefs();
  const results = [];

  for (const def of defs) {
    try {
      startService(def.label);
      results.push({ label: def.label, displayName: def.displayName, ok: true, error: null });
    } catch (e) {
      results.push({ label: def.label, displayName: def.displayName, ok: false, error: e.message });
    }
  }

  return results;
}

/**
 * Stop all services (managed ones via launchctl, ollama via brew).
 */
export function stopAllServices() {
  const defs = getServiceDefs();
  const results = [];

  for (const def of defs) {
    try {
      stopService(def.label);
      results.push({ label: def.label, displayName: def.displayName, ok: true, error: null });
    } catch (e) {
      results.push({ label: def.label, displayName: def.displayName, ok: false, error: e.message });
    }
  }

  return results;
}

/**
 * Tail the last N lines of a service's log file.
 */
export function getServiceLogs(label, lines = 50) {
  const def = getServiceDefs().find((d) => d.label === label);
  if (!def) throw new Error(`Unknown service: ${label}`);

  const logFile = def.logPath;
  if (!logFile || !existsSync(logFile)) {
    return `(no log file found at ${logFile || "unknown path"})`;
  }

  try {
    const output = execSync(`tail -n ${lines} "${logFile}"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return output;
  } catch {
    return "(failed to read log file)";
  }
}
