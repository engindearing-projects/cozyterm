// Permission manager — interactive allow/deny/always-allow per tool
// Persists "always allow" rules to ~/.cozyterm/permissions.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PermissionManager, PermissionResult } from "../tools/types.js";

type PermissionLevel = "always_allow" | "always_deny" | "ask";

interface PermissionRule {
  tool: string;
  level: PermissionLevel;
  pattern?: string; // Optional regex pattern for params (e.g. command patterns for bash)
}

interface PermissionState {
  rules: PermissionRule[];
  sessionAllowed: Set<string>; // Tools allowed for this session only
}

const PERM_FILE = join(homedir(), ".cozyterm", "permissions.json");

// Default rules — safe tools auto-allow, dangerous ones ask
const DEFAULT_RULES: PermissionRule[] = [
  { tool: "read_file", level: "always_allow" },
  { tool: "glob", level: "always_allow" },
  { tool: "grep", level: "always_allow" },
  { tool: "diagnostics", level: "always_allow" },
  { tool: "edit_file", level: "ask" },
  { tool: "write_file", level: "ask" },
  { tool: "bash", level: "ask" },
];

export type PromptFn = (
  tool: string,
  detail: string,
) => Promise<"allow" | "deny" | "always_allow" | "always_deny">;

export class InteractivePermissionManager implements PermissionManager {
  private state: PermissionState;
  private promptFn: PromptFn;

  constructor(promptFn: PromptFn) {
    this.promptFn = promptFn;
    this.state = {
      rules: loadRules(),
      sessionAllowed: new Set(),
    };
  }

  async check(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<PermissionResult> {
    // Check persistent rules first
    const rule = this.findRule(tool);

    if (rule?.level === "always_allow") {
      return { allowed: true };
    }
    if (rule?.level === "always_deny") {
      return { allowed: false, reason: `"${tool}" is permanently denied` };
    }

    // Check session-level allowances
    const sessionKey = this.makeSessionKey(tool, params);
    if (this.state.sessionAllowed.has(sessionKey) || this.state.sessionAllowed.has(tool)) {
      return { allowed: true };
    }

    // Need to ask the user
    const detail = formatToolDetail(tool, params);
    const response = await this.promptFn(tool, detail);

    switch (response) {
      case "allow":
        this.state.sessionAllowed.add(sessionKey);
        return { allowed: true };
      case "always_allow":
        this.addRule({ tool, level: "always_allow" });
        return { allowed: true };
      case "always_deny":
        this.addRule({ tool, level: "always_deny" });
        return { allowed: false, reason: `"${tool}" permanently denied by user` };
      case "deny":
        return { allowed: false, reason: `"${tool}" denied by user` };
    }
  }

  private findRule(tool: string): PermissionRule | undefined {
    return this.state.rules.find((r) => r.tool === tool);
  }

  private addRule(rule: PermissionRule): void {
    // Remove existing rule for this tool
    this.state.rules = this.state.rules.filter((r) => r.tool !== rule.tool);
    this.state.rules.push(rule);
    saveRules(this.state.rules);
  }

  private makeSessionKey(tool: string, params: Record<string, unknown>): string {
    if (tool === "bash") return `bash:${params.command}`;
    if (tool === "write_file" || tool === "edit_file") return `${tool}:${params.path}`;
    return tool;
  }

  // Allow all tools without prompting (for --yes mode or tests)
  static autoAllow(): PermissionManager {
    return {
      async check() {
        return { allowed: true };
      },
    };
  }

  // Read-only mode — only allow read tools
  static readOnly(): PermissionManager {
    const readTools = new Set(["read_file", "glob", "grep", "diagnostics"]);
    return {
      async check(tool: string) {
        if (readTools.has(tool)) return { allowed: true };
        return { allowed: false, reason: "Read-only mode" };
      },
    };
  }
}

function formatToolDetail(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case "bash":
      return `$ ${params.command}`;
    case "write_file":
      return `write → ${params.path}`;
    case "edit_file":
      return `edit → ${params.path}`;
    default:
      return JSON.stringify(params).slice(0, 120);
  }
}

function loadRules(): PermissionRule[] {
  try {
    if (existsSync(PERM_FILE)) {
      const data = JSON.parse(readFileSync(PERM_FILE, "utf-8"));
      return data.rules || DEFAULT_RULES;
    }
  } catch {
    // Corrupted file — use defaults
  }
  return [...DEFAULT_RULES];
}

function saveRules(rules: PermissionRule[]): void {
  try {
    const dir = join(homedir(), ".cozyterm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PERM_FILE, JSON.stringify({ rules }, null, 2), "utf-8");
  } catch {
    // Non-critical — permissions will be asked again next session
  }
}
