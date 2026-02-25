// Planner agent — read-only agent for analysis and exploration
// Only has: read, glob, grep, diagnostics (no write/edit/bash)

import type { Provider } from "../providers/types.js";
import type { PermissionManager } from "../tools/types.js";
import type { LSPManager } from "../lsp/manager.js";
import { Agent } from "./agent.js";
import { readTool } from "../tools/read.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { createDiagnosticsTool } from "../tools/diagnostics.js";

const SYSTEM_PROMPT = `You are CozyTerm in planning mode — a read-only analysis agent.

You can explore the codebase, read files, search for patterns, check diagnostics, and provide detailed analysis. You CANNOT modify files or run commands. Use this mode to understand code, plan changes, and answer questions.

## Tools
- read_file: Read file contents
- glob: Find files by pattern
- grep: Search file contents
- diagnostics: Check for type errors and warnings (if LSP is active)

## Approach
1. Explore broadly first — use glob and grep to find relevant files
2. Read key files thoroughly
3. Check diagnostics for existing issues
4. Provide structured analysis with specific file:line references
5. When planning changes, list exact files and what needs to change`;

export function createPlannerAgent(
  provider: Provider,
  cwd: string,
  permissions: PermissionManager,
  maxTurns = 30,
  lsp?: LSPManager,
): Agent {
  const tools = [readTool, globTool, grepTool];

  if (lsp && lsp.activeServers.length > 0) {
    tools.push(createDiagnosticsTool(lsp));
  }

  return new Agent({
    name: "planner",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    provider,
    maxTurns,
    cwd,
    permissions,
  });
}
