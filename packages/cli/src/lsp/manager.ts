// LSP Manager — detects project languages, starts appropriate servers,
// provides unified diagnostics across all active servers

import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { LSPClient, type DiagnosticEntry } from "./client.js";
import { EventEmitter } from "events";

interface ServerConfig {
  language: string;
  command: string;
  args: string[];
  extensions: string[];
  detectFiles: string[]; // If any exist in project root, start this server
}

// Language server configs — add more as needed
const SERVER_CONFIGS: ServerConfig[] = [
  {
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    detectFiles: ["tsconfig.json", "package.json", "jsconfig.json"],
  },
  {
    language: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
    detectFiles: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
  },
  {
    language: "go",
    command: "gopls",
    args: ["serve"],
    extensions: [".go"],
    detectFiles: ["go.mod", "go.sum"],
  },
  {
    language: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    detectFiles: ["Cargo.toml"],
  },
];

interface LSPManagerEvents {
  diagnostics: [file: string, diagnostics: DiagnosticEntry[]];
  server_started: [language: string];
  server_error: [language: string, error: Error];
}

export class LSPManager extends EventEmitter<LSPManagerEvents> {
  private clients = new Map<string, LSPClient>();
  private rootPath: string;
  private extensionToLanguage = new Map<string, string>();

  constructor(rootPath: string) {
    super();
    this.rootPath = rootPath;

    // Build extension → language map
    for (const config of SERVER_CONFIGS) {
      for (const ext of config.extensions) {
        this.extensionToLanguage.set(ext, config.language);
      }
    }
  }

  // Auto-detect project languages and start relevant servers
  async autoStart(): Promise<string[]> {
    const started: string[] = [];

    for (const config of SERVER_CONFIGS) {
      const detected = config.detectFiles.some((f) =>
        existsSync(join(this.rootPath, f)),
      );

      if (detected) {
        try {
          await this.startServer(config);
          started.push(config.language);
        } catch {
          // Server binary not installed — skip silently
        }
      }
    }

    return started;
  }

  private async startServer(config: ServerConfig): Promise<void> {
    if (this.clients.has(config.language)) return;

    // Check if the binary exists before trying to spawn
    try {
      execSync(`which ${config.command}`, { stdio: "ignore" });
    } catch {
      return; // Binary not installed, skip silently
    }

    const client = new LSPClient(
      config.command,
      config.args,
      this.rootPath,
      config.language,
    );

    // Forward diagnostics
    client.on("diagnostics", (file, diags) => {
      this.emit("diagnostics", file, diags);
    });

    client.on("error", (err) => {
      this.emit("server_error", config.language, err);
    });

    // Start with timeout — don't hang on broken servers
    try {
      await Promise.race([
        client.start(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("LSP start timeout")), 5000),
        ),
      ]);
      this.clients.set(config.language, client);
      this.emit("server_started", config.language);
    } catch {
      await client.stop().catch(() => {});
      // Server failed to start — skip
    }
  }

  // Get the right LSP client for a file based on extension
  getClientForFile(filePath: string): LSPClient | null {
    const ext = "." + filePath.split(".").pop();
    const language = this.extensionToLanguage.get(ext);
    if (!language) return null;
    return this.clients.get(language) || null;
  }

  // Notify that a file was changed (routes to correct server)
  async notifyFileChanged(filePath: string, content: string): Promise<void> {
    const client = this.getClientForFile(filePath);
    if (!client) return;

    // Ensure file is open first
    await client.openFile(filePath);
    await client.notifyChange(filePath, content);
  }

  // Wait for diagnostics after a file change
  async getDiagnosticsAfterChange(
    filePath: string,
    content: string,
    timeoutMs = 5000,
  ): Promise<DiagnosticEntry[]> {
    const client = this.getClientForFile(filePath);
    if (!client || !client.isReady) return [];

    await client.openFile(filePath);
    await client.notifyChange(filePath, content);
    return client.waitForDiagnostics(filePath, timeoutMs);
  }

  // Get all current diagnostics across all servers
  getAllDiagnostics(): DiagnosticEntry[] {
    const all: DiagnosticEntry[] = [];
    for (const client of this.clients.values()) {
      all.push(...client.getDiagnostics());
    }
    return all;
  }

  // Get diagnostics filtered to errors only
  getErrors(): DiagnosticEntry[] {
    return this.getAllDiagnostics().filter((d) => d.severity === "error");
  }

  get activeServers(): string[] {
    return Array.from(this.clients.keys());
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }
}
