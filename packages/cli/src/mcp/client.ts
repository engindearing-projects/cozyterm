// MCP client — connects to Model Context Protocol servers
// Discovers tools dynamically and makes them available to the agent

import { spawn, type ChildProcess } from "child_process";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";

interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private config: MCPServerConfig;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private tools: MCPToolSchema[] = [];

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn MCP server: ${this.config.command}`);
    }

    this.process.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.on("error", (err) => {
      for (const [, pending] of this.pending) {
        pending.reject(err);
      }
      this.pending.clear();
    });

    // Initialize
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cozyterm", version: "0.2.0" },
    });

    await this.send("notifications/initialized", {});

    // List tools
    const result = (await this.send("tools/list", {})) as { tools: MCPToolSchema[] };
    this.tools = result.tools || [];
  }

  private processBuffer(): void {
    // MCP uses Content-Length framed JSON-RPC
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1]);
      const contentStart = headerEnd + 4;

      if (this.buffer.length < contentStart + contentLength) break;

      const content = this.buffer.slice(contentStart, contentStart + contentLength);
      this.buffer = this.buffer.slice(contentStart + contentLength);

      try {
        const msg = JSON.parse(content) as MCPMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Skip malformed messages
      }
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("MCP server not connected"));
        return;
      }

      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const msg: MCPMessage = { jsonrpc: "2.0", id, method, params };
      const body = JSON.stringify(msg);
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      this.process.stdin.write(frame);
    });
  }

  // Convert MCP tools to CozyTerm Tool interface
  getTools(): Tool[] {
    return this.tools.map((mcpTool) => ({
      name: `mcp_${mcpTool.name}`,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,

      run: async (
        params: Record<string, unknown>,
        _ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const result = (await this.send("tools/call", {
            name: mcpTool.name,
            arguments: params,
          })) as { content: { type: string; text: string }[] };

          const text = result.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") || "(no output)";

          return { output: text };
        } catch (err) {
          return {
            output: "",
            error: `MCP tool "${mcpTool.name}" failed: ${(err as Error).message}`,
          };
        }
      },
    }));
  }

  get toolCount(): number {
    return this.tools.length;
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.pending.clear();
    this.tools = [];
  }
}

// Load MCP server configs from .cozyterm.json
export interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>;
}

export async function loadMCPTools(config: MCPConfig): Promise<{ tools: Tool[]; servers: string[] }> {
  const allTools: Tool[] = [];
  const servers: string[] = [];

  if (!config.mcpServers) return { tools: allTools, servers };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const client = new MCPClient(serverConfig);
      await client.connect();
      const tools = client.getTools();
      allTools.push(...tools);
      servers.push(`${name} (${tools.length} tools)`);
    } catch {
      // Server failed to start — skip silently
    }
  }

  return { tools: allTools, servers };
}
