// Multi-model provider — routes to specialized models per role
// Orchestrator handles tool calls, delegates to specialists for content

import { OllamaProvider } from "./ollama.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  StreamEvent,
  ToolDefinition,
} from "./types.js";

export interface ModelRoles {
  // Drives the agent loop — must support native tool calling
  orchestrator: { model: string; temperature?: number };
  // Generates/edits code content
  coder: { model: string; temperature?: number };
  // Deep analysis, planning, debugging
  reasoner: { model: string; temperature?: number };
  // Conversation, context, quick answers
  chat: { model: string; temperature?: number };
}

export const DEFAULT_ROLES: ModelRoles = {
  orchestrator: { model: "qwen2.5:7b-instruct", temperature: 0.3 },
  coder: { model: "engie-coder:latest", temperature: 0.7 },
  reasoner: { model: "glm-4.7-flash:latest", temperature: 0.4 },
  chat: { model: "llama3.2:latest", temperature: 0.7 },
};

export type ModelRole = keyof ModelRoles;

// Classify what role a task needs based on context
export function classifyRole(
  prompt: string,
  hasToolCalls: boolean,
): ModelRole {
  // If we're in a tool-calling loop, always use orchestrator
  if (hasToolCalls) return "orchestrator";

  const lower = prompt.toLowerCase();

  // Coding patterns
  const codingPatterns = [
    /\b(write|create|implement|add|build)\b.*\b(function|class|component|endpoint|api|module|file)\b/,
    /\b(refactor|rewrite|convert|migrate)\b/,
    /```[\s\S]*```/,
    /\b(fix|patch|update)\b.*\b(code|bug|error|issue)\b/,
  ];

  // Reasoning patterns
  const reasoningPatterns = [
    /\b(explain|analyze|debug|investigate|trace|diagnose)\b/,
    /\b(plan|design|architect|strategy)\b/,
    /\b(compare|evaluate|review|assess)\b/,
    /\bwhy\b.*\b(error|fail|broken|wrong|issue)\b/,
    /\b(root cause|stack trace|performance)\b/,
  ];

  // Chat patterns (quick/simple)
  const chatPatterns = [
    /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/i,
    /\b(status|remind|list|show|what is|what's)\b/i,
    /^.{0,50}$/, // Very short prompts
  ];

  for (const p of reasoningPatterns) {
    if (p.test(lower)) return "reasoner";
  }
  for (const p of codingPatterns) {
    if (p.test(lower)) return "coder";
  }
  for (const p of chatPatterns) {
    if (p.test(prompt)) return "chat";
  }

  // Default: orchestrator handles it (can call tools if needed)
  return "orchestrator";
}

/**
 * Multi-model provider that wraps multiple Ollama models.
 *
 * For the agent loop (tool calling), always uses the orchestrator.
 * For pure text generation, picks the best model for the task.
 * The orchestrator can also dispatch to specialists via internal routing.
 */
export class MultiModelProvider implements Provider {
  name = "multi-model";
  model: string; // Shows current active model
  private host: string;
  private roles: ModelRoles;
  private providers: Map<ModelRole, OllamaProvider>;
  private activeRole: ModelRole = "orchestrator";

  constructor(host: string, roles?: Partial<ModelRoles>) {
    this.host = host;
    this.roles = { ...DEFAULT_ROLES, ...roles };
    this.model = this.roles.orchestrator.model;

    this.providers = new Map();
    for (const [role, config] of Object.entries(this.roles)) {
      this.providers.set(
        role as ModelRole,
        new OllamaProvider(host, config.model),
      );
    }
  }

  private getProvider(role: ModelRole): OllamaProvider {
    return this.providers.get(role)!;
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<ProviderResponse> {
    // If tools are provided, always use orchestrator (it handles tool calling)
    if (tools?.length) {
      this.activeRole = "orchestrator";
      this.model = this.roles.orchestrator.model;
      return this.getProvider("orchestrator").chat(messages, tools);
    }

    // No tools — classify and route to best model
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg?.content || "";
    const role = classifyRole(prompt, false);

    this.activeRole = role;
    this.model = this.roles[role].model;
    return this.getProvider(role).chat(messages);
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    if (tools?.length) {
      this.activeRole = "orchestrator";
      this.model = this.roles.orchestrator.model;
      yield* this.getProvider("orchestrator").stream(messages, tools);
      return;
    }

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg?.content || "";
    const role = classifyRole(prompt, false);

    this.activeRole = role;
    this.model = this.roles[role].model;
    yield* this.getProvider(role).stream(messages);
  }

  // Expose which role is active for status display
  get currentRole(): ModelRole {
    return this.activeRole;
  }

  // Check which models are actually available in Ollama
  static async checkAvailability(
    host: string,
    roles: ModelRoles,
  ): Promise<{ available: ModelRole[]; missing: { role: ModelRole; model: string }[] }> {
    const installedModels = await OllamaProvider.discover(host);
    const available: ModelRole[] = [];
    const missing: { role: ModelRole; model: string }[] = [];

    for (const [role, config] of Object.entries(roles)) {
      // Check if model name matches (with or without :latest tag)
      const found = installedModels.some(
        (m) =>
          m === config.model ||
          m === config.model.replace(":latest", "") ||
          m.startsWith(config.model.split(":")[0]),
      );
      if (found) {
        available.push(role as ModelRole);
      } else {
        missing.push({ role: role as ModelRole, model: config.model });
      }
    }

    return { available, missing };
  }
}
