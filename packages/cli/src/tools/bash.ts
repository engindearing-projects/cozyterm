// Bash tool — execute shell commands with safety gates

import { spawn } from "child_process";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// Commands that should always be blocked
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+[\/~]/,         // rm -rf with absolute/home paths
  /\bsudo\b/,                     // sudo
  /\bgit\s+push\s+--force/,      // force push
  /\bgit\s+reset\s+--hard/,      // hard reset
  /\bDROP\s+(TABLE|DATABASE)/i,   // SQL drops
  /\b>\s*\/dev\/sd/,              // writing to block devices
  /\bmkfs\b/,                     // format filesystems
  /\bdd\s+if=/,                   // disk dump
];

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command and return its output (stdout + stderr). " +
    "Commands run in the project working directory. " +
    "Dangerous commands (rm -rf /, sudo, force push, etc.) are blocked. " +
    "Commands time out after 30 seconds by default.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) || DEFAULT_TIMEOUT;

    // Safety check
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          output: "",
          error: `Blocked: "${command}" matches a dangerous pattern. Run it manually if needed.`,
        };
      }
    }

    // Permission check
    const perm = await ctx.permissions.check("bash", { command });
    if (!perm.allowed) {
      return { output: "", error: `Permission denied: ${perm.reason}` };
    }

    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        timeout,
        env: { ...process.env, TERM: "dumb" }, // avoid escape sequences
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        // Truncate very long outputs
        const maxLen = 50_000;
        const truncated =
          output.length > maxLen
            ? output.slice(0, maxLen) + `\n... (truncated, ${output.length} total chars)`
            : output;

        if (code !== 0) {
          resolve({
            output: truncated,
            error: `Command exited with code ${code}`,
            metadata: { exitCode: code },
          });
        } else {
          resolve({
            output: truncated || "(no output)",
            metadata: { exitCode: 0 },
          });
        }
      });

      proc.on("error", (err) => {
        resolve({
          output: "",
          error: `Failed to execute: ${err.message}`,
        });
      });
    });
  },
};
