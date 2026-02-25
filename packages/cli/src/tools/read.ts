// Read tool — read file contents with optional line range

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const readTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file content with line numbers. " +
    "Use offset and limit for large files. Returns an error if the file doesn't exist.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to working directory or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based). Default: 1",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Default: 2000",
      },
    },
    required: ["path"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, params.path as string);
    const offset = ((params.offset as number) || 1) - 1; // Convert to 0-based
    const limit = (params.limit as number) || 2000;

    if (!existsSync(filePath)) {
      return { output: "", error: `File not found: ${filePath}` };
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return { output: "", error: `Path is a directory, not a file: ${filePath}` };
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice
        .map((line, i) => `${String(offset + i + 1).padStart(5)}  ${line}`)
        .join("\n");

      const totalLines = lines.length;
      const header = `File: ${filePath} (${totalLines} lines)`;
      const truncated =
        offset + limit < totalLines
          ? `\n... (${totalLines - offset - limit} more lines)`
          : "";

      return {
        output: `${header}\n${numbered}${truncated}`,
        metadata: { totalLines, filePath },
      };
    } catch (err) {
      return {
        output: "",
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }
  },
};
