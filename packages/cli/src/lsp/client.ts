// LSP client — connects to language servers via stdio JSON-RPC
// Sends didOpen/didChange, receives diagnostics, feeds them back to the agent

import { spawn, type ChildProcess } from "child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type {
  InitializeParams,
  Diagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { EventEmitter } from "events";

export interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

interface LSPClientEvents {
  diagnostics: [file: string, diagnostics: DiagnosticEntry[]];
  error: [error: Error];
  ready: [];
}

export class LSPClient extends EventEmitter<LSPClientEvents> {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private diagnosticStore = new Map<string, DiagnosticEntry[]>();
  private documentVersions = new Map<string, number>();
  private rootUri: string;
  private language: string;
  private ready = false;

  constructor(
    private command: string,
    private args: string[],
    private rootPath: string,
    language: string,
  ) {
    super();
    this.rootUri = pathToFileURL(rootPath).toString();
    this.language = language;
  }

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn ${this.command}`);
    }

    this.process.stderr?.on("data", () => {
      // Suppress stderr from language servers — they're noisy
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    this.process.on("exit", () => {
      this.ready = false;
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );

    // Listen for diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        const filePath = new URL(params.uri).pathname;
        const entries = params.diagnostics.map((d) => toDiagnosticEntry(filePath, d));
        this.diagnosticStore.set(filePath, entries);
        this.emit("diagnostics", filePath, entries);
      },
    );

    this.connection.listen();

    // Initialize
    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
      workspaceFolders: [
        { uri: this.rootUri, name: this.rootPath.split("/").pop() || "" },
      ],
    };

    await this.connection.sendRequest("initialize", initParams);
    this.connection.sendNotification("initialized", {});
    this.ready = true;
    this.emit("ready");
  }

  async openFile(filePath: string): Promise<void> {
    if (!this.connection || !this.ready) return;

    const absPath = resolve(this.rootPath, filePath);
    if (!existsSync(absPath)) return;

    const uri = pathToFileURL(absPath).toString();
    const content = readFileSync(absPath, "utf-8");

    this.documentVersions.set(absPath, 1);

    this.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.language,
        version: 1,
        text: content,
      },
    });
  }

  async notifyChange(filePath: string, newContent: string): Promise<void> {
    if (!this.connection || !this.ready) return;

    const absPath = resolve(this.rootPath, filePath);
    const uri = pathToFileURL(absPath).toString();

    let version = this.documentVersions.get(absPath) || 0;
    version++;
    this.documentVersions.set(absPath, version);

    // Full document sync (simplest — works with all servers)
    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: newContent }],
    });
  }

  closeFile(filePath: string): void {
    if (!this.connection || !this.ready) return;

    const absPath = resolve(this.rootPath, filePath);
    const uri = pathToFileURL(absPath).toString();

    this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });

    this.documentVersions.delete(absPath);
    this.diagnosticStore.delete(absPath);
  }

  // Get current diagnostics for a file (or all files)
  getDiagnostics(filePath?: string): DiagnosticEntry[] {
    if (filePath) {
      const absPath = resolve(this.rootPath, filePath);
      return this.diagnosticStore.get(absPath) || [];
    }
    // All diagnostics
    const all: DiagnosticEntry[] = [];
    for (const entries of this.diagnosticStore.values()) {
      all.push(...entries);
    }
    return all;
  }

  // Wait for diagnostics to arrive after a change (with timeout)
  waitForDiagnostics(filePath: string, timeoutMs = 5000): Promise<DiagnosticEntry[]> {
    const absPath = resolve(this.rootPath, filePath);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener("diagnostics", handler);
        resolve(this.diagnosticStore.get(absPath) || []);
      }, timeoutMs);

      const handler = (file: string, diags: DiagnosticEntry[]) => {
        if (file === absPath) {
          clearTimeout(timer);
          this.removeListener("diagnostics", handler);
          resolve(diags);
        }
      };

      this.on("diagnostics", handler);
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

function toDiagnosticEntry(filePath: string, d: Diagnostic): DiagnosticEntry {
  const severityMap: Record<number, DiagnosticEntry["severity"]> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
  };

  return {
    file: filePath,
    line: d.range.start.line + 1, // LSP is 0-based, we display 1-based
    column: d.range.start.character + 1,
    severity: severityMap[d.severity || 4] || "info",
    message: d.message,
    source: d.source,
  };
}
