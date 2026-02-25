// Provider interface — every LLM backend implements this

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  model: string;
  finishReason: "stop" | "tool_use" | "length" | "error";
}

export interface StreamEvent {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "done" | "error";
  text?: string;
  toolCall?: Partial<ToolCall>;
  error?: string;
  usage?: ProviderResponse["usage"];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Provider {
  name: string;
  model: string;

  chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<ProviderResponse>;

  stream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent>;
}
