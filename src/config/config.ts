// Configuration loader — reads .cozyterm.json from project root and ~/.cozyterm/config.json

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export interface CozyConfig {
  // Provider settings
  provider: "multi" | "ollama" | "anthropic" | "openai" | "auto";
  ollama: {
    host: string;
    model: string;
  };
  anthropic: {
    model: string;
  };
  openai: {
    baseUrl?: string;
    model: string;
  };

  // Multi-model settings — specialized models per role
  models: {
    orchestrator: string; // Tool calling / agent loop (needs native function calling)
    coder: string;        // Code generation and editing
    reasoner: string;     // Deep analysis, planning, debugging
    chat: string;         // Conversation, quick answers, context
  };

  // Router settings
  router: {
    enabled: boolean;
    complexityThreshold: number; // 0.0 - 1.0, above this → cloud provider
    localProvider: "ollama";
    cloudProvider: "anthropic" | "openai";
  };

  // Agent settings
  agent: {
    maxTurns: number;
    maxTokens: number;
    systemPrompt?: string;
  };

  // TUI settings
  tui: {
    theme: string;
    vim: boolean;
  };

  // Forge collector
  forge: {
    enabled: boolean;
    dataDir: string;
  };
}

const DEFAULTS: CozyConfig = {
  provider: "multi",
  ollama: {
    host: "http://localhost:11434",
    model: "qwen2.5:7b-instruct",
  },
  anthropic: {
    model: "claude-sonnet-4-20250514",
  },
  openai: {
    model: "gpt-4o",
  },
  models: {
    orchestrator: "qwen2.5:7b-instruct",
    coder: "engie-coder:latest",
    reasoner: "glm-4.7-flash:latest",
    chat: "llama3.2:latest",
  },
  router: {
    enabled: true,
    complexityThreshold: 0.45,
    localProvider: "ollama",
    cloudProvider: "anthropic",
  },
  agent: {
    maxTurns: 50,
    maxTokens: 8192,
    systemPrompt: undefined,
  },
  tui: {
    theme: "cozyterm",
    vim: false,
  },
  forge: {
    enabled: true,
    dataDir: join(homedir(), ".cozyterm", "forge"),
  },
};

function findProjectRoot(from: string): string | null {
  let dir = resolve(from);
  while (dir !== "/") {
    if (
      existsSync(join(dir, ".cozyterm.json")) ||
      existsSync(join(dir, ".git"))
    ) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  return null;
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function loadConfig(cwd?: string): CozyConfig {
  const workDir = cwd || process.cwd();
  const projectRoot = findProjectRoot(workDir);

  // Layer: defaults ← global config ← project config ← env vars
  const globalConfig = loadJsonFile(
    join(homedir(), ".cozyterm", "config.json"),
  );
  const projectConfig = projectRoot
    ? loadJsonFile(join(projectRoot, ".cozyterm.json"))
    : null;

  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    globalConfig || {},
    projectConfig || {},
  ) as unknown as CozyConfig;

  // Env var overrides
  if (process.env.OLLAMA_HOST) merged.ollama.host = process.env.OLLAMA_HOST;
  if (process.env.OLLAMA_MODEL) merged.ollama.model = process.env.OLLAMA_MODEL;
  if (process.env.ANTHROPIC_MODEL)
    merged.anthropic.model = process.env.ANTHROPIC_MODEL;
  if (process.env.COZY_PROVIDER)
    merged.provider = process.env.COZY_PROVIDER as CozyConfig["provider"];

  return merged;
}

function deepMerge(...objects: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === "object"
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result;
}
