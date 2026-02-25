// Forge collector — captures prompt/response pairs for training data
// Every interaction feeds back into the model improvement loop

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "../providers/types.js";

interface TrainingPair {
  timestamp: string;
  provider: string;
  model: string;
  messages: Message[];
  tokenUsage: { input: number; output: number };
  duration: number;
  cwd: string;
  tools: string[];
}

const FORGE_DIR = join(homedir(), ".cozyterm", "forge");

export class ForgeCollector {
  private enabled: boolean;
  private dataDir: string;

  constructor(enabled = true, dataDir?: string) {
    this.enabled = enabled;
    this.dataDir = dataDir || FORGE_DIR;

    if (this.enabled && !existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  collect(pair: TrainingPair): void {
    if (!this.enabled) return;

    try {
      const date = new Date().toISOString().split("T")[0];
      const filePath = join(this.dataDir, `${date}.jsonl`);
      const line = JSON.stringify(pair) + "\n";
      appendFileSync(filePath, line, "utf-8");
    } catch {
      // Don't let collection failures break the user's workflow
    }
  }

  // Wrap an agent run to automatically collect the interaction
  wrapRun(
    provider: string,
    model: string,
    cwd: string,
    tools: string[],
    messages: readonly Message[],
    tokenUsage: { input: number; output: number },
    duration: number,
  ): void {
    this.collect({
      timestamp: new Date().toISOString(),
      provider,
      model,
      messages: [...messages],
      tokenUsage,
      duration,
      cwd,
      tools,
    });
  }

  stats(): { pairsToday: number; totalFiles: number } | null {
    if (!this.enabled || !existsSync(this.dataDir)) return null;

    try {
      const { readdirSync, readFileSync } = require("fs");
      const files = readdirSync(this.dataDir).filter((f: string) =>
        f.endsWith(".jsonl"),
      );

      const today = new Date().toISOString().split("T")[0];
      const todayFile = join(this.dataDir, `${today}.jsonl`);
      let pairsToday = 0;
      if (existsSync(todayFile)) {
        const content = readFileSync(todayFile, "utf-8");
        pairsToday = content.trim().split("\n").filter(Boolean).length;
      }

      return { pairsToday, totalFiles: files.length };
    } catch {
      return null;
    }
  }
}
