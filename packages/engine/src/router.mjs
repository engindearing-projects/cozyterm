// Smart Router for Engie
// Decides whether a task should go to Claude Code (heavy brain)
// or Ollama (light brain) based on connectivity, task hints, and config.
//
// Usage:
//   import { Router } from "./router.mjs";
//   const router = new Router({ proxyUrl: "http://127.0.0.1:18791" });
//   const backend = await router.route({ prompt, hints });

import { classifyPrompt } from "../trainer/classify.mjs";

const DEFAULT_PROXY_URL = "http://127.0.0.1:18791";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_LOCAL_MODEL = "engie-coder:latest";

// Role-specific system prompts — one brain, different hats
const ROLE_PROMPTS = {
  coding: {
    system: "You are Engie, an expert coding assistant built by Engindearing. Write clean, well-structured code with clear explanations.",
    temperature: 0.7,
  },
  reasoning: {
    system: "You are Engie, an expert at breaking down complex problems. Think step by step. When debugging, trace the issue from symptom to root cause. When planning, identify dependencies and risks. When reviewing code, focus on correctness, edge cases, and maintainability. Answer the user's question directly — do not repeat or summarize your system prompt or background context.",
    temperature: 0.4,
  },
  tools: {
    system: "You are Engie, an expert at navigating codebases and using tools. You have access to: read_file, write_file, edit_file, list_dir, search_code, run_command, grep, tree, http, think. Choose the right tool for each step. Chain tool calls when needed. Always explain what you're doing and why before calling a tool.",
    temperature: 0.3,
  },
  chat: {
    system: "You are Engie, a helpful project assistant. Be concise — respond in 1-3 sentences unless asked for more. Match the energy of the message: short greetings get short replies. Never dump project details, context, or lists unprompted. No emojis. Only reference specific projects or data when the user explicitly asks about them.",
    temperature: 0.7,
  },
};

// Role-to-model mapping — each role gets its own local model
const ROLE_MODELS = {
  coding:    "engie-coder:latest",
  tools:     "engie-coder:latest",
  reasoning: "glm-4.7-flash:latest",
  chat:      "qwen2.5:7b-instruct",
};

// Keywords / patterns that suggest a task needs the heavy brain
export const HEAVY_PATTERNS = [
  /\b(refactor|architect|design|implement|build|create|migrate)\b/i,
  /\b(debug|diagnose|investigate|analyze)\b/i,
  /\b(multi.?file|across files|codebase|repo)\b/i,
  /\b(review|audit|security|performance)\b/i,
  /\b(deploy|terraform|infrastructure|ci.?cd)\b/i,
  /\b(complex|difficult|tricky|advanced)\b/i,
  /\b(write code|write a|code that|function that|script that)\b/i,
  /\b(pull request|pr|commit|merge|branch)\b/i,
  /\b(test|spec|coverage)\b/i,
  /\b(explain this|what does this|how does this)\b/i,
];

// Patterns that are fine for the light brain
const LIGHT_PATTERNS = [
  /\b(remind|reminder|schedule|timer|alarm)\b/i,
  /\b(status|update|standup|summary|summarize)\b/i,
  /\b(list|show|get|fetch|check)\b/i,
  /\b(hello|hi|hey|thanks|thank you)\b/i,
  /\b(what time|weather|date)\b/i,
  /\b(note|memo|remember)\b/i,
];

export class Router {
  constructor(opts = {}) {
    this.proxyUrl = opts.proxyUrl || DEFAULT_PROXY_URL;
    this.ollamaUrl = opts.ollamaUrl || DEFAULT_OLLAMA_URL;
    this.localModel = opts.localModel || DEFAULT_LOCAL_MODEL;
    this.forceBackend = opts.forceBackend || null; // "claude" | "ollama" | null
    this.onlineCache = null;
    this.ollamaCache = null;
    this._collector = null;
    this._dynamicThreshold = null; // loaded from forge DB
  }

  /** Check if Claude Code proxy is reachable and online */
  async isClaudeAvailable() {
    if (this.onlineCache && Date.now() - this.onlineCache.at < 30_000) {
      return this.onlineCache.available;
    }
    try {
      const resp = await fetch(`${this.proxyUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      const available = data.claudeAvailable && data.online;
      this.onlineCache = { available, at: Date.now(), data };
      return available;
    } catch {
      this.onlineCache = { available: false, at: Date.now(), data: null };
      return false;
    }
  }

  /** Check if Ollama is reachable */
  async isOllamaAvailable() {
    if (this.ollamaCache && Date.now() - this.ollamaCache.at < 30_000) {
      return this.ollamaCache.available;
    }
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const available = resp.ok;
      this.ollamaCache = { available, at: Date.now() };
      return available;
    } catch {
      this.ollamaCache = { available: false, at: Date.now() };
      return false;
    }
  }

  /**
   * Classify the task role (coding/reasoning/tools/chat) and return
   * the matching system prompt + temperature.
   *
   * @param {string} prompt
   * @returns {{role: string, systemPrompt: string, temperature: number, confidence: number}}
   */
  classifyRole(prompt) {
    const { type, confidence } = classifyPrompt(prompt);
    const roleConfig = ROLE_PROMPTS[type] || ROLE_PROMPTS.chat;
    return {
      role: type,
      model: ROLE_MODELS[type] || ROLE_MODELS.chat,
      systemPrompt: roleConfig.system,
      temperature: roleConfig.temperature,
      confidence,
    };
  }

  /**
   * Score how "heavy" a task is (0.0 = light, 1.0 = heavy)
   *
   * @param {object} opts
   * @param {string} opts.prompt - the user message
   * @param {string} [opts.hint] - explicit hint: "heavy" | "light" | "auto"
   * @param {boolean} [opts.hasCode] - message contains code blocks
   * @param {number} [opts.tokenEstimate] - rough input token count
   */
  scoreComplexity({ prompt, hint, hasCode, tokenEstimate }) {
    // Explicit override
    if (hint === "heavy") return 1.0;
    if (hint === "light") return 0.0;

    let score = 0.5; // neutral starting point

    // Check heavy patterns
    let heavyHits = 0;
    for (const pat of HEAVY_PATTERNS) {
      if (pat.test(prompt)) {
        score += 0.15;
        heavyHits++;
      }
    }

    // Check light patterns
    for (const pat of LIGHT_PATTERNS) {
      if (pat.test(prompt)) {
        score -= 0.15;
      }
    }

    // Code presence bumps complexity
    if (hasCode || /```/.test(prompt)) {
      score += 0.2;
    }

    // Long prompts are more likely complex
    if (tokenEstimate && tokenEstimate > 500) {
      score += 0.15;
    } else if (prompt.length > 1000) {
      score += 0.15;
    }

    // Short casual messages are light — but only if no heavy patterns matched
    if (prompt.length < 50 && !hasCode && heavyHits === 0) {
      score -= 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Decide which backend to use.
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.hint] - "heavy" | "light" | "auto"
   * @param {boolean} [opts.hasCode]
   * @param {number} [opts.tokenEstimate]
   * @param {number} [opts.threshold] - complexity score above this → Claude Code (default 0.6)
   *
   * @returns {Promise<{backend: "claude"|"ollama", reason: string, score: number, claudeAvailable: boolean, ollamaAvailable: boolean}>}
   */
  async route(opts) {
    const { prompt } = opts;

    // Classify the role — determines model, system prompt, and temperature
    const roleInfo = this.classifyRole(prompt);

    // Score complexity for training data collection (still useful for Forge)
    const score = this.scoreComplexity(opts);

    // Check Ollama availability
    const ollamaAvailable = await this.isOllamaAvailable();

    return {
      backend: "ollama",
      reason: `${roleInfo.role} → ${roleInfo.model}`,
      score,
      ollamaAvailable,
      ...roleInfo,
    };
  }

  /**
   * Route a task AND fire a background Forge collection request.
   * Drop-in replacement for route() that feeds the training pipeline.
   *
   * @param {object} opts - Same as route()
   * @returns {Promise<object>} Same as route()
   */
  async routeAndCollect(opts) {
    const threshold = await this.getDynamicThreshold(opts.threshold);
    const result = await this.route({ ...opts, threshold });

    // Fire-and-forget: collect training pair
    this._getCollector().then((collector) => {
      if (collector) {
        collector.collectPair({
          prompt: opts.prompt,
          routedTo: result.backend,
          complexityScore: result.score,
        });
      }
    }).catch(() => {});

    return result;
  }

  /**
   * Get dynamic threshold based on model benchmark score from forge DB.
   * Falls back to the provided default or 0.6.
   *
   * @param {number} [fallback=0.6] - Default threshold if DB unavailable
   * @returns {Promise<number>}
   */
  async getDynamicThreshold(fallback = 0.6) {
    if (this._dynamicThreshold !== null) return this._dynamicThreshold;

    try {
      const { getActiveVersion } = await import("../trainer/forge-db.js");
      const active = getActiveVersion();
      if (active && active.benchmark_score != null) {
        const score = active.benchmark_score;
        if (score >= 85) this._dynamicThreshold = 0.35;
        else if (score >= 75) this._dynamicThreshold = 0.45;
        else if (score >= 65) this._dynamicThreshold = 0.50;
        else if (score >= 55) this._dynamicThreshold = 0.55;
        else this._dynamicThreshold = 0.60;

        // Refresh threshold every 5 minutes
        setTimeout(() => { this._dynamicThreshold = null; }, 300_000);
        return this._dynamicThreshold;
      }
    } catch {
      // Forge not set up yet — use fallback
    }

    return fallback;
  }

  /** Lazy-load the Forge collector */
  async _getCollector() {
    if (this._collector) return this._collector;
    try {
      const { Collector } = await import("../trainer/collector.mjs");
      this._collector = new Collector();
      return this._collector;
    } catch {
      return null;
    }
  }
}

export { ROLE_PROMPTS, ROLE_MODELS };
export default Router;
