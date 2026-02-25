// Agent loop — the core of CozyTerm
// Sends messages to provider, executes tool calls, iterates until done

import type { Message, Provider, ToolCall } from "../providers/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { toolToDefinition } from "../tools/types.js";
import { EventEmitter } from "events";

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: Tool[];
  provider: Provider;
  maxTurns: number;
  cwd: string;
  permissions: ToolContext["permissions"];
}

export interface AgentEvents {
  thinking: [];
  text: [text: string];
  tool_start: [name: string, args: Record<string, unknown>];
  tool_end: [name: string, result: ToolResult];
  turn: [turnNumber: number, totalTokens: number];
  done: [finalMessage: string];
  error: [error: Error];
}

export class Agent extends EventEmitter<AgentEvents> {
  readonly config: AgentConfig;
  private messages: Message[] = [];
  private toolMap: Map<string, Tool>;
  private totalTokens = { input: 0, output: 0 };

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.toolMap = new Map(config.tools.map((t) => [t.name, t]));

    // Seed with system prompt
    this.messages.push({
      role: "system",
      content: config.systemPrompt,
    });
  }

  get tokenUsage() {
    return { ...this.totalTokens };
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  async run(userMessage: string): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    const toolDefs = this.config.tools.map(toolToDefinition);
    const ctx: ToolContext = {
      cwd: this.config.cwd,
      sessionId: `${Date.now()}`,
      permissions: this.config.permissions,
    };

    let turn = 0;

    while (turn < this.config.maxTurns) {
      turn++;
      this.emit("thinking");

      let response;
      try {
        response = await this.config.provider.chat(this.messages, toolDefs);
      } catch (err) {
        const error = err as Error;
        this.emit("error", error);
        return `Error from ${this.config.provider.name}: ${error.message}`;
      }

      // Track token usage
      if (response.usage) {
        this.totalTokens.input += response.usage.inputTokens;
        this.totalTokens.output += response.usage.outputTokens;
      }

      this.emit("turn", turn, this.totalTokens.input + this.totalTokens.output);

      // Emit any text content
      if (response.content) {
        this.emit("text", response.content);
      }

      // If no tool calls, we're done
      if (!response.toolCalls.length) {
        const finalMessage = response.content;
        this.messages.push({
          role: "assistant",
          content: finalMessage,
        });
        this.emit("done", finalMessage);
        return finalMessage;
      }

      // Record assistant message with tool calls
      this.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        const result = await this.executeTool(toolCall, ctx);

        // Record tool result
        this.messages.push({
          role: "tool",
          content: result.error
            ? `ERROR: ${result.error}\n${result.output}`
            : result.output,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }
    }

    const timeoutMsg = `Reached maximum turns (${this.config.maxTurns}). Stopping.`;
    this.emit("done", timeoutMsg);
    return timeoutMsg;
  }

  private async executeTool(
    toolCall: ToolCall,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.toolMap.get(toolCall.name);
    if (!tool) {
      return {
        output: "",
        error: `Unknown tool: ${toolCall.name}. Available: ${this.toolMap.size ? Array.from(this.toolMap.keys()).join(", ") : "none"}`,
      };
    }

    this.emit("tool_start", toolCall.name, toolCall.arguments);

    try {
      const result = await tool.run(toolCall.arguments, ctx);
      this.emit("tool_end", toolCall.name, result);
      return result;
    } catch (err) {
      const error = err as Error;
      const result: ToolResult = {
        output: "",
        error: `Tool "${toolCall.name}" crashed: ${error.message}`,
      };
      this.emit("tool_end", toolCall.name, result);
      return result;
    }
  }
}
