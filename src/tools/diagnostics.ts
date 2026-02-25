// Diagnostics tool — retrieves LSP errors/warnings for the agent
// This is the self-correction loop: edit file → get diagnostics → fix errors

import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { LSPManager } from "../lsp/manager.js";
import type { DiagnosticEntry } from "../lsp/client.js";

export function createDiagnosticsTool(lsp: LSPManager): Tool {
  return {
    name: "diagnostics",
    description:
      "Get LSP diagnostics (type errors, lint warnings, etc.) for a file or the whole project. " +
      "Use this AFTER editing files to check for errors and fix them. " +
      "Returns errors with file path, line number, and message.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path to check (relative to project root). Omit to get all project diagnostics.",
        },
        severity: {
          type: "string",
          enum: ["all", "errors", "warnings"],
          description: "Filter by severity (default: all)",
        },
      },
      required: [],
    },

    async run(
      params: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const filePath = params.path as string | undefined;
      const severity = (params.severity as string) || "all";

      let diagnostics: DiagnosticEntry[];

      if (filePath) {
        const client = lsp.getClientForFile(filePath);
        if (!client) {
          return {
            output: `No language server available for ${filePath}`,
            metadata: { count: 0 },
          };
        }
        diagnostics = client.getDiagnostics(filePath);
      } else {
        diagnostics = lsp.getAllDiagnostics();
      }

      // Filter by severity
      if (severity === "errors") {
        diagnostics = diagnostics.filter((d) => d.severity === "error");
      } else if (severity === "warnings") {
        diagnostics = diagnostics.filter(
          (d) => d.severity === "error" || d.severity === "warning",
        );
      }

      if (diagnostics.length === 0) {
        return {
          output: filePath
            ? `No diagnostics for ${filePath}`
            : "No diagnostics found",
          metadata: { count: 0 },
        };
      }

      const formatted = diagnostics
        .map((d) => {
          const sev = d.severity.toUpperCase();
          const src = d.source ? ` (${d.source})` : "";
          return `${d.file}:${d.line}:${d.column} ${sev}${src}: ${d.message}`;
        })
        .join("\n");

      const errorCount = diagnostics.filter((d) => d.severity === "error").length;
      const warnCount = diagnostics.filter((d) => d.severity === "warning").length;
      const summary = `${errorCount} error${errorCount !== 1 ? "s" : ""}, ${warnCount} warning${warnCount !== 1 ? "s" : ""}`;

      return {
        output: `${summary}:\n${formatted}`,
        metadata: {
          count: diagnostics.length,
          errors: errorCount,
          warnings: warnCount,
        },
      };
    },
  };
}
