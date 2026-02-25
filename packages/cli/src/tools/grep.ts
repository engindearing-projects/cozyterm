// Grep tool — search file contents using ripgrep (falls back to node grep)

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { glob } from "glob";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search for a regex pattern in file contents. Uses ripgrep (rg) if available, " +
    "otherwise falls back to a built-in implementation. " +
    "Returns matching lines with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search in (default: working directory)",
      },
      glob: {
        type: "string",
        description: "Only search files matching this glob (e.g. '*.ts', '*.py')",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive search (default: false)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matching lines to return (default: 100)",
      },
    },
    required: ["pattern"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = params.path
      ? resolve(ctx.cwd, params.path as string)
      : ctx.cwd;
    const fileGlob = params.glob as string | undefined;
    const caseInsensitive = (params.case_insensitive as boolean) || false;
    const maxResults = (params.max_results as number) || 100;

    // Try ripgrep first
    try {
      const result = await runRipgrep(
        pattern,
        searchPath,
        fileGlob,
        caseInsensitive,
        maxResults,
        ctx.cwd,
      );
      return result;
    } catch {
      // ripgrep not available, fall back
    }

    // Fallback: built-in grep
    return fallbackGrep(pattern, searchPath, fileGlob, caseInsensitive, maxResults, ctx.cwd);
  },
};

function runRipgrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  caseInsensitive: boolean,
  maxResults: number,
  cwd: string,
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-heading",
      "--line-number",
      "--color=never",
      `--max-count=${maxResults}`,
    ];
    if (caseInsensitive) args.push("-i");
    if (fileGlob) args.push("--glob", fileGlob);
    args.push(pattern, searchPath);

    const proc = spawn("rg", args, {
      cwd,
      timeout: 10_000,
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

    proc.on("error", () => reject(new Error("rg not found")));

    proc.on("close", (code) => {
      if (code === 1 && !stderr) {
        // rg exits 1 when no matches
        resolve({ output: `No matches for "${pattern}"` });
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr || `rg exited with ${code}`));
        return;
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      resolve({
        output: lines.length
          ? `${lines.length} matches:\n${lines.join("\n")}`
          : `No matches for "${pattern}"`,
        metadata: { count: lines.length, engine: "ripgrep" },
      });
    });
  });
}

async function fallbackGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  caseInsensitive: boolean,
  maxResults: number,
  cwd: string,
): Promise<ToolResult> {
  const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
  const globPattern = fileGlob || "**/*";

  let files: string[];
  try {
    if (existsSync(searchPath) && !require("fs").statSync(searchPath).isDirectory()) {
      files = [searchPath];
    } else {
      files = await glob(globPattern, {
        cwd: searchPath,
        nodir: true,
        absolute: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      });
    }
  } catch {
    return { output: "", error: "Failed to list files for grep" };
  }

  const results: string[] = [];

  for (const file of files) {
    if (results.length >= maxResults) break;
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const rel = file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
          results.push(`${rel}:${i + 1}:${lines[i]}`);
          if (results.length >= maxResults) break;
        }
      }
    } catch {
      // Skip binary/unreadable files
    }
  }

  return {
    output: results.length
      ? `${results.length} matches:\n${results.join("\n")}`
      : `No matches for "${pattern}"`,
    metadata: { count: results.length, engine: "builtin" },
  };
}
