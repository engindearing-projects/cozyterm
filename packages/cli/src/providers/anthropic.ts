// Anthropic provider — Claude as the cloud fallback

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  Provider,
  ProviderResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types.js";

export class AnthropicProvider implements Provider {
  name = "anthropic";
  model: string;
  private client: Anthropic;

  constructor(model: string, apiKey?: string) {
    this.model = model;
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<ProviderResponse> {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemMsg?.content || undefined,
      messages: toAnthropicMessages(nonSystemMessages),
      tools: tools?.length ? toAnthropicTools(tools) : undefined,
    });

    const content = extractContent(response.content);
    const toolCalls = extractToolCalls(response.content);

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: this.model,
      finishReason: response.stop_reason === "tool_use" ? "tool_use" : "stop",
    };
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemMsg?.content || undefined,
      messages: toAnthropicMessages(nonSystemMessages),
      tools: tools?.length ? toAnthropicTools(tools) : undefined,
    });

    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolArgs = "";
            yield {
              type: "tool_call_start",
              toolCall: { id: block.id, name: block.name },
            };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            currentToolArgs += delta.partial_json;
            yield {
              type: "tool_call_delta",
              toolCall: { id: currentToolId, name: currentToolName },
              text: delta.partial_json,
            };
          }
          break;
        }
        case "content_block_stop": {
          if (currentToolName && currentToolArgs) {
            try {
              yield {
                type: "tool_call_start",
                toolCall: {
                  id: currentToolId,
                  name: currentToolName,
                  arguments: JSON.parse(currentToolArgs),
                },
              };
            } catch {
              // args may be empty for some tool calls
            }
            currentToolName = "";
            currentToolArgs = "";
          }
          break;
        }
        case "message_stop": {
          yield { type: "done" };
          break;
        }
      }
    }
  }
}

function toAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      // Anthropic expects tool results as user messages with tool_result blocks
      const lastMsg = result[result.length - 1];
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId || "",
        content: msg.content,
      };
      if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
        (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResult);
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    } else if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    }
  }

  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

function extractContent(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractToolCalls(blocks: Anthropic.ContentBlock[]): ToolCall[] {
  return blocks
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));
}
