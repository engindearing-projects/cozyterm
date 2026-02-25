// Glob tool — find files by pattern

import { glob as globFn } from "glob";
import { resolve, relative } from "path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/*.tsx'). " +
    "Returns matching file paths relative to the working directory, sorted by path. " +
    "Use this to discover files before reading them.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match (e.g. '**/*.ts', 'src/components/*.tsx')",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: working directory)",
      },
    },
    required: ["pattern"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchDir = params.path
      ? resolve(ctx.cwd, params.path as string)
      : ctx.cwd;

    try {
      const matches = await globFn(pattern, {
        cwd: searchDir,
        nodir: true,
        dot: false,
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          "**/.venv/**",
          "**/__pycache__/**",
        ],
      });

      matches.sort();

      if (matches.length === 0) {
        return { output: `No files matching "${pattern}" in ${relative(ctx.cwd, searchDir) || "."}` };
      }

      const MAX = 200;
      const display = matches.slice(0, MAX);
      const truncated = matches.length > MAX
        ? `\n... and ${matches.length - MAX} more files`
        : "";

      return {
        output: `Found ${matches.length} files:\n${display.join("\n")}${truncated}`,
        metadata: { count: matches.length },
      };
    } catch (err) {
      return {
        output: "",
        error: `Glob failed: ${(err as Error).message}`,
      };
    }
  },
};
