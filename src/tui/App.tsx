// Root TUI component — ties everything together
// LSP, permissions, Forge collector, multi-model, streaming

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Provider } from "../providers/types.js";
import type { PermissionManager, Tool } from "../tools/types.js";
import type { LSPManager } from "../lsp/manager.js";
import { InteractivePermissionManager, type PromptFn } from "../permissions/manager.js";
import { createCoderAgent } from "../agents/coder.js";
import { createPlannerAgent } from "../agents/planner.js";
import { ForgeCollector } from "../forge/collector.js";
import { getTheme } from "./themes/theme.js";
import { Chat, type ChatMessage } from "./components/Chat.js";
import { Editor } from "./components/Editor.js";
import { StatusBar } from "./components/StatusBar.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";

// Load all themes
import "./themes/cozyterm.js";
import "./themes/dracula.js";
import "./themes/tokyonight.js";

interface AppProps {
  provider: Provider;
  cwd: string;
  themeName: string;
  permissions: PermissionManager;
  forgeEnabled: boolean;
  maxTurns: number;
  lsp?: LSPManager;
  mcpTools?: Tool[];
}

export function App({
  provider,
  cwd,
  themeName,
  forgeEnabled,
  maxTurns,
  lsp,
  mcpTools,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = getTheme(themeName);
  const rows = stdout?.rows || 40;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [agentMode, setAgentMode] = useState<"coder" | "planner">("coder");
  const [turn, setTurn] = useState(0);
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  const [forgeStats, setForgeStats] = useState<{
    pairsToday: number;
    totalFiles: number;
  } | null>(null);

  // Permission prompt state
  const [permPrompt, setPermPrompt] = useState<{
    tool: string;
    detail: string;
    resolve: (r: "allow" | "deny" | "always_allow" | "always_deny") => void;
  } | null>(null);

  const collector = useRef(new ForgeCollector(forgeEnabled));

  // Build welcome message
  useEffect(() => {
    const lspInfo = lsp?.activeServers.length
      ? ` LSP: ${lsp.activeServers.join(", ")}.`
      : "";
    const mcpInfo = mcpTools?.length ? ` MCP: ${mcpTools.length} tools.` : "";

    setMessages([
      {
        role: "assistant",
        content: `Welcome to CozyTerm. Using ${provider.name}/${provider.model}.${lspInfo}${mcpInfo} Type anything to get started.`,
      },
    ]);
  }, []);

  // Forge stats
  useEffect(() => {
    setForgeStats(collector.current.stats());
  }, [messages.length]);

  // Interactive permission manager — prompts through the TUI
  const permissionManager = useRef(
    new InteractivePermissionManager(((tool: string, detail: string) => {
      return new Promise<"allow" | "deny" | "always_allow" | "always_deny">((resolve) => {
        setPermPrompt({ tool, detail, resolve });
      });
    }) as PromptFn),
  );

  // Tab to switch agents
  useInput((input, key) => {
    if (key.tab && !isLoading && !permPrompt) {
      setAgentMode((prev) => (prev === "coder" ? "planner" : "coder"));
    }
  });

  const handlePermResponse = useCallback(
    (response: "allow" | "deny" | "always_allow" | "always_deny") => {
      if (permPrompt) {
        permPrompt.resolve(response);
        setPermPrompt(null);
      }
    },
    [permPrompt],
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setIsLoading(true);
      setTurn(0);

      const startTime = Date.now();

      const agent =
        agentMode === "coder"
          ? createCoderAgent(provider, cwd, permissionManager.current, maxTurns, lsp, mcpTools)
          : createPlannerAgent(provider, cwd, permissionManager.current, maxTurns, lsp);

      agent.on("tool_start", (name, args) => {
        const summary =
          name === "bash"
            ? `$ ${(args.command as string) || ""}`
            : name === "read_file"
              ? `reading ${args.path}`
              : name === "edit_file"
                ? `editing ${args.path}`
                : name === "write_file"
                  ? `writing ${args.path}`
                  : name === "glob"
                    ? `searching ${args.pattern}`
                    : name === "grep"
                      ? `grep ${args.pattern}`
                      : name === "diagnostics"
                        ? `checking ${args.path || "all files"}`
                        : name === "undo"
                          ? `reverting ${args.path || "session"}`
                          : JSON.stringify(args).slice(0, 60);

        setMessages((prev) => [
          ...prev,
          { role: "tool", content: summary, toolName: name },
        ]);
      });

      agent.on("tool_end", (name, result) => {
        if (result.error) {
          setMessages((prev) => [
            ...prev,
            { role: "tool", content: result.error!, toolName: name, isError: true },
          ]);
        }
      });

      agent.on("turn", (t) => {
        setTurn(t);
      });

      try {
        const finalMessage = await agent.run(text);
        const usage = agent.tokenUsage;
        setTokens(usage);

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: finalMessage },
        ]);

        collector.current.wrapRun(
          provider.name,
          provider.model,
          cwd,
          agent.config.tools.map((t: Tool) => t.name),
          agent.history,
          usage,
          Date.now() - startTime,
        );
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${(err as Error).message}`, isError: true },
        ]);
      }

      setIsLoading(false);
    },
    [agentMode, provider, cwd, maxTurns, lsp, mcpTools],
  );

  const chatHeight = rows - 6;

  return (
    <Box flexDirection="column" height={rows}>
      <Chat theme={theme} messages={messages} height={chatHeight} />

      {permPrompt ? (
        <PermissionPrompt
          theme={theme}
          tool={permPrompt.tool}
          detail={permPrompt.detail}
          onRespond={handlePermResponse}
        />
      ) : (
        <Editor
          theme={theme}
          onSubmit={handleSubmit}
          isLoading={isLoading}
          placeholder={
            agentMode === "planner"
              ? "planning mode (read-only) — tab to switch"
              : undefined
          }
        />
      )}

      <StatusBar
        theme={theme}
        provider={provider.name}
        model={provider.model}
        tokens={tokens}
        turn={turn}
        agentMode={agentMode}
        forgeStats={forgeStats}
        lspServers={lsp?.activeServers}
      />
    </Box>
  );
}
