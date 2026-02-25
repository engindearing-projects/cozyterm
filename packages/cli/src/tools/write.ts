// Write tool — create or overwrite a file

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { recordChange } from "../sessions/history.js";

export const writeTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file with the provided content. " +
    "Creates parent directories if they don't exist. Use edit_file for partial changes.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to working directory or absolute)",
      },
      content: {
        type: "string",
        description: "The full content to write to the file",
      },
    },
    required: ["path", "content"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, params.path as string);
    const content = params.content as string;
    const existed = existsSync(filePath);
    const beforeContent = existed ? readFileSync(filePath, "utf-8") : null;

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, content, "utf-8");

      // Record for undo
      recordChange(
        ctx.sessionId,
        filePath,
        existed ? "write" : "create",
        beforeContent,
        content,
      );

      const lines = content.split("\n").length;
      const action = existed ? "Overwrote" : "Created";
      return {
        output: `${action} ${filePath} (${lines} lines)`,
        metadata: { filePath, lines, existed },
      };
    } catch (err) {
      return {
        output: "",
        error: `Failed to write file: ${(err as Error).message}`,
      };
    }
  },
};
