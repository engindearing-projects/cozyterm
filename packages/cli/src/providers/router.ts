// Smart router — picks local (Ollama) vs cloud (Anthropic) based on task complexity
// Ported from the Forge router.mjs logic

import type { Provider } from "./types.js";
import type { CozyConfig } from "../config/config.js";
import { OllamaProvider } from "./ollama.js";
import { AnthropicProvider } from "./anthropic.js";

// Patterns that signal high complexity → route to cloud
const HEAVY_PATTERNS = [
  /refactor/i,
  /architect/i,
  /debug.*complex/i,
  /investigate/i,
  /multi.?file/i,
  /security/i,
  /deploy/i,
  /terraform/i,
  /review.*code/i,
  /explain.*this.*code/i,
  /```[\s\S]{500,}/,  // Large code blocks
  /\b(design|plan|strategy)\b.*\b(system|architecture|migration)\b/i,
];

// Patterns that signal low complexity → local is fine
const LIGHT_PATTERNS = [
  /^(hello|hi|hey)\b/i,
  /\bstatus\b/i,
  /\blist\b/i,
  /\bshow\b/i,
  /\bread\b.*\bfile\b/i,
  /\bfind\b.*\bfile/i,
  /\bsearch\b/i,
  /\brename\b/i,
  /\badd.*import/i,
  /\bfix.*typo/i,
];

export function scoreComplexity(prompt: string): number {
  let score = 0.3; // baseline

  for (const pattern of HEAVY_PATTERNS) {
    if (pattern.test(prompt)) score += 0.15;
  }
  for (const pattern of LIGHT_PATTERNS) {
    if (pattern.test(prompt)) score -= 0.1;
  }

  // Length heuristic — longer prompts tend to be more complex
  if (prompt.length > 1000) score += 0.1;
  if (prompt.length > 3000) score += 0.1;

  // Multiple questions/requests
  const questionMarks = (prompt.match(/\?/g) || []).length;
  if (questionMarks > 2) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

export function createRouter(config: CozyConfig): {
  route: (prompt: string) => Provider;
  local: Provider;
  cloud: Provider;
} {
  const local = new OllamaProvider(config.ollama.host, config.ollama.model);
  const cloud = new AnthropicProvider(config.anthropic.model);

  function route(prompt: string): Provider {
    if (config.provider !== "auto") {
      // Explicit provider override
      switch (config.provider) {
        case "ollama":
          return local;
        case "anthropic":
          return cloud;
        default:
          return local;
      }
    }

    if (!config.router.enabled) return local;

    const complexity = scoreComplexity(prompt);
    const threshold = config.router.complexityThreshold;

    return complexity >= threshold ? cloud : local;
  }

  return { route, local, cloud };
}
