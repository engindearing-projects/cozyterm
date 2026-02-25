// Custom commands — load user-defined prompt templates from .cozyterm/commands/
// Commands are markdown files: filename becomes the command name, contents become the prompt
//
// Example: .cozyterm/commands/review.md
//   Review the changes in the current git diff. Focus on:
//   - Security issues
//   - Performance problems
//   - Code style violations
//
// Usage: cozy /review

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export interface CustomCommand {
  name: string;
  prompt: string;
  source: "project" | "global";
  filePath: string;
}

export function loadCustomCommands(projectRoot?: string): CustomCommand[] {
  const commands: CustomCommand[] = [];
  const seen = new Set<string>();

  // Project commands take priority over global
  if (projectRoot) {
    const projectDir = join(projectRoot, ".cozyterm", "commands");
    loadFromDir(projectDir, "project", commands, seen);
  }

  // Global commands
  const globalDir = join(homedir(), ".cozyterm", "commands");
  loadFromDir(globalDir, "global", commands, seen);

  return commands;
}

function loadFromDir(
  dir: string,
  source: "project" | "global",
  commands: CustomCommand[],
  seen: Set<string>,
): void {
  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const name = basename(file, ".md");
      if (seen.has(name)) continue; // Project overrides global

      const filePath = join(dir, file);
      const prompt = readFileSync(filePath, "utf-8").trim();

      if (prompt) {
        commands.push({ name, prompt, source, filePath });
        seen.add(name);
      }
    }
  } catch {
    // Dir exists but unreadable — skip
  }
}

export function listCommands(commands: CustomCommand[]): string {
  if (commands.length === 0) return "No custom commands found.";

  return commands
    .map((cmd) => {
      const preview = cmd.prompt.split("\n")[0].slice(0, 60);
      return `  /${cmd.name.padEnd(16)} ${preview}${cmd.prompt.length > 60 ? "..." : ""}  (${cmd.source})`;
    })
    .join("\n");
}

// Resolve a /command from user input
export function resolveCommand(
  input: string,
  commands: CustomCommand[],
): { prompt: string; command: CustomCommand } | null {
  if (!input.startsWith("/")) return null;

  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0];
  const args = parts.slice(1).join(" ");

  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) return null;

  // Replace {{args}} or append args to prompt
  let prompt = cmd.prompt;
  if (prompt.includes("{{args}}")) {
    prompt = prompt.replace(/\{\{args\}\}/g, args);
  } else if (args) {
    prompt = `${prompt}\n\n${args}`;
  }

  return { prompt, command: cmd };
}
