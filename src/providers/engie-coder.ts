// Engie-coder provider — custom tool calling for our fine-tuned model
// engie-coder uses prompt-based tool calling (XML <tool_call> tags)
// instead of the OpenAI-compatible tool calling API

import type {
  Message,
  Provider,
  ProviderResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types.js";

export class EngieCoderProvider implements Provider {
  name = "engie-coder";
  model: string;
  private host: string;

  constructor(host: string, model = "engie-coder:latest") {
    this.host = host;
    this.model = model;
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<ProviderResponse> {
    // Inject tool definitions into the system prompt
    const augmented = injectToolsIntoMessages(messages, tools);

    const res = await fetch(`${this.host}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: augmented.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: 0.7,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices: [{ message: { content: string } }];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = data.choices[0].message.content;

    // Parse tool calls from the response text
    const { text, toolCalls } = parseToolCalls(content);

    return {
      content: text,
      toolCalls,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
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
    // For now, use non-streaming and emit as single events
    // Streaming with prompt-based tools is tricky (need to detect tool_call mid-stream)
    const response = await this.chat(messages, tools);

    if (response.content) {
      yield { type: "text_delta", text: response.content };
    }
    for (const tc of response.toolCalls) {
      yield {
        type: "tool_call_start",
        toolCall: tc,
      };
    }
    yield { type: "done", usage: response.usage };
  }
}

// Inject tool definitions as a system-level instruction
function injectToolsIntoMessages(
  messages: Message[],
  tools?: ToolDefinition[],
): Message[] {
  if (!tools?.length) return messages;

  const toolBlock = tools
    .map(
      (t) =>
        `<tool name="${t.name}">\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}\n</tool>`,
    )
    .join("\n\n");

  const toolInstructions = `You have access to these tools. To use a tool, respond with a <tool_call> block:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

You can make multiple tool calls in one response. After tool results come back, continue your response.

Available tools:
${toolBlock}`;

  const result = [...messages];
  const sysIdx = result.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    result[sysIdx] = {
      ...result[sysIdx],
      content: result[sysIdx].content + "\n\n" + toolInstructions,
    };
  } else {
    result.unshift({ role: "system", content: toolInstructions });
  }

  return result;
}

// Parse <tool_call> blocks from model output
// Supports: <tool_call>{"name":"...", "arguments":{...}}</tool_call>
// Also supports: ```json\n{"name":"...", "arguments":{...}}\n``` (fallback)
function parseToolCalls(content: string): {
  text: string;
  toolCalls: ToolCall[];
} {
  const toolCalls: ToolCall[] = [];
  let text = content;
  let callIndex = 0;

  // Pattern 1: <tool_call>...</tool_call>
  const xmlPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  while ((match = xmlPattern.exec(content)) !== null) {
    try {
      const parsed = parseToolJson(match[1].trim());
      if (parsed) {
        toolCalls.push({
          id: `tc_${callIndex++}`,
          name: parsed.name,
          arguments: parsed.arguments || {},
        });
        text = text.replace(match[0], "").trim();
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  // Pattern 2: ```json code blocks with tool call shape (only if no XML matches found)
  if (toolCalls.length === 0) {
    const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
    while ((match = codeBlockPattern.exec(content)) !== null) {
      try {
        const parsed = parseToolJson(match[1].trim());
        if (parsed && parsed.name) {
          toolCalls.push({
            id: `tc_${callIndex++}`,
            name: parsed.name,
            arguments: parsed.arguments || {},
          });
          text = text.replace(match[0], "").trim();
        }
      } catch {
        // Not a tool call, just a code block
      }
    }
  }

  return { text, toolCalls };
}

// Parse JSON with tolerance for single quotes and trailing commas
function parseToolJson(
  raw: string,
): { name: string; arguments: Record<string, unknown> } | null {
  // Try standard JSON first
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.name === "string") return obj;
  } catch {
    // Try fixing common issues
  }

  // Fix single quotes
  try {
    const fixed = raw.replace(/'/g, '"');
    const obj = JSON.parse(fixed);
    if (obj && typeof obj.name === "string") return obj;
  } catch {
    // Give up
  }

  // Fix trailing commas
  try {
    const fixed = raw.replace(/,\s*([\]}])/g, "$1");
    const obj = JSON.parse(fixed);
    if (obj && typeof obj.name === "string") return obj;
  } catch {
    // Give up
  }

  return null;
}
