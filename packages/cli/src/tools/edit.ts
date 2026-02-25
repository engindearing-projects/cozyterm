// Edit tool — targeted find-and-replace in files (like OpenCode/Claude Code)

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { recordChange } from "../sessions/history.js";

export const editTool: Tool = {
  name: "edit_file",
  description:
    "Make targeted edits to a file by replacing exact string matches. " +
    "The old_string must match exactly (including whitespace/indentation). " +
    "Use replace_all: true to replace every occurrence. " +
    "Always read the file first to see exact content before editing.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false, replaces first only)",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async run(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, params.path as string);
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) || false;

    if (!existsSync(filePath)) {
      return { output: "", error: `File not found: ${filePath}` };
    }

    try {
      const beforeContent = readFileSync(filePath, "utf-8");
      let content = beforeContent;

      if (!content.includes(oldString)) {
        return {
          output: "",
          error: `old_string not found in ${filePath}. Make sure it matches exactly (including whitespace).`,
        };
      }

      // Count occurrences
      const occurrences = content.split(oldString).length - 1;

      if (replaceAll) {
        content = content.replaceAll(oldString, newString);
      } else {
        if (occurrences > 1) {
          return {
            output: "",
            error: `old_string has ${occurrences} matches in ${filePath}. ` +
              `Provide more context to make it unique, or use replace_all: true.`,
          };
        }
        content = content.replace(oldString, newString);
      }

      writeFileSync(filePath, content, "utf-8");

      // Record for undo
      recordChange(ctx.sessionId, filePath, "edit", beforeContent, content);

      const replaced = replaceAll ? occurrences : 1;
      return {
        output: `Edited ${filePath}: replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}`,
        metadata: { filePath, occurrences: replaced },
      };
    } catch (err) {
      return {
        output: "",
        error: `Failed to edit file: ${(err as Error).message}`,
      };
    }
  },
};
