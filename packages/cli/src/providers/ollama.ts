// Ollama provider — talks to local Ollama via OpenAI-compatible API
// First-class citizen, not a generic "local" fallback

import OpenAI from "openai";
import type {
  Message,
  Provider,
  ProviderResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types.js";

export class OllamaProvider implements Provider {
  name = "ollama";
  model: string;
  private client: OpenAI;

  constructor(host: string, model: string) {
    this.model = model;
    this.client = new OpenAI({
      baseURL: `${host}/v1`,
      apiKey: "ollama", // Ollama doesn't need a real key
    });
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      tools: tools?.length ? toOpenAITools(tools) : undefined,
      temperature: 0.7,
      stream: false,
    });

    const choice = response.choices[0];
    const toolCalls = extractToolCalls(choice.message.tool_calls);

    return {
      content: choice.message.content || "",
      toolCalls,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
      model: this.model,
      finishReason: toolCalls.length > 0 ? "tool_use" : "stop",
    };
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      tools: tools?.length ? toOpenAITools(tools) : undefined,
      temperature: 0.7,
      stream: true,
    });

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!pendingToolCalls.has(idx)) {
            pendingToolCalls.set(idx, {
              id: tc.id || `tool_${idx}`,
              name: tc.function?.name || "",
              args: "",
            });
            if (tc.function?.name) {
              yield {
                type: "tool_call_start",
                toolCall: {
                  id: tc.id || `tool_${idx}`,
                  name: tc.function.name,
                },
              };
            }
          }
          const pending = pendingToolCalls.get(idx)!;
          if (tc.function?.name) pending.name = tc.function.name;
          if (tc.function?.arguments) {
            pending.args += tc.function.arguments;
            yield {
              type: "tool_call_delta",
              toolCall: { id: pending.id, name: pending.name },
              text: tc.function.arguments,
            };
          }
        }
      }
    }

    // Emit final tool calls
    for (const [, tc] of pendingToolCalls) {
      try {
        yield {
          type: "tool_call_start",
          toolCall: {
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.args),
          },
        };
      } catch {
        yield {
          type: "error",
          error: `Failed to parse tool call arguments for ${tc.name}`,
        };
      }
    }

    yield { type: "done" };
  }

  // Check if Ollama is running and model is available
  static async discover(host: string): Promise<string[]> {
    try {
      const res = await fetch(`${host}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }
}

// Convert our messages to OpenAI format
function toOpenAIMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: m.toolCallId || "",
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    };
  });
}

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function extractToolCalls(
  calls?: OpenAI.ChatCompletionMessageToolCall[],
): ToolCall[] {
  if (!calls) return [];
  return calls.map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: JSON.parse(c.function.arguments),
  }));
}
