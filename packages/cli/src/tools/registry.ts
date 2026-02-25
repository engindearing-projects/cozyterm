// Tool registry — collects all tools and provides lookup

import type { Tool } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";
import { toolToDefinition } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.all().map(toolToDefinition);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}
