// Tool interface — every tool implements this

import type { ToolDefinition } from "../providers/types.js";

export interface ToolResult {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  permissions: PermissionManager;
}

export interface PermissionManager {
  check(tool: string, params: Record<string, unknown>): Promise<PermissionResult>;
}

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object

  run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
