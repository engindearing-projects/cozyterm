// Undo tool — revert the last file change

import type { Tool, ToolContext, ToolResult } from "./types.js";
import { undoLastChange, getFileChanges, undoSession } from "../sessions/history.js";

export const undoTool: Tool = {
  name: "undo",
  description:
    "Undo the last edit/write to a file, restoring it to its previous state. " +
    "Specify a file path to undo the last change to that file, " +
    "or use scope 'session' to undo ALL changes made in the current session.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to undo (relative to working directory)",
      },
      scope: {
        type: "string",
        enum: ["file", "session"],
        description: "Undo scope: 'file' (default) undoes last change to a file, 'session' undoes all session changes",
      },
    },
    required: [],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const scope = (params.scope as string) || "file";
    const filePath = params.path as string | undefined;

    if (scope === "session") {
      const result = undoSession(ctx.sessionId);
      const output = `Undid ${result.undone} change${result.undone !== 1 ? "s" : ""}`;
      if (result.errors.length > 0) {
        return {
          output: `${output}\nErrors:\n${result.errors.join("\n")}`,
          error: result.errors.length > 0 ? `${result.errors.length} files couldn't be reverted` : undefined,
        };
      }
      return { output };
    }

    if (!filePath) {
      return { output: "", error: "Specify a file path to undo, or use scope: 'session'" };
    }

    const { resolve } = require("path");
    const absPath = resolve(ctx.cwd, filePath);
    const result = undoLastChange(absPath);

    return {
      output: result.message,
      error: result.success ? undefined : result.message,
    };
  },
};
