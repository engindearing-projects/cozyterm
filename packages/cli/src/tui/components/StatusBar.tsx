// Status bar — shows model, tokens, session info at the bottom

import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../themes/theme.js";

interface StatusBarProps {
  theme: Theme;
  provider: string;
  model: string;
  tokens: { input: number; output: number };
  turn: number;
  agentMode: "coder" | "planner";
  forgeStats?: { pairsToday: number; totalFiles: number } | null;
  lspServers?: string[];
}

export function StatusBar({
  theme,
  provider,
  model,
  tokens,
  turn,
  agentMode,
  forgeStats,
  lspServers,
}: StatusBarProps) {
  const totalTokens = tokens.input + tokens.output;
  const tokenStr =
    totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}k tokens` : "";

  return (
    <Box
      borderStyle="single"
      borderColor={theme.borderDim}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        <Text color={theme.accent} bold>
          cozy
        </Text>
        <Text color={theme.textMuted}>
          {provider}/{model}
        </Text>
        <Text color={agentMode === "coder" ? theme.success : theme.info}>
          [{agentMode}]
        </Text>
      </Box>
      <Box gap={2}>
        {lspServers && lspServers.length > 0 && (
          <Text color={theme.success}>
            lsp: {lspServers.join(",")}
          </Text>
        )}
        {forgeStats && (
          <Text color={theme.textMuted}>
            forge: {forgeStats.pairsToday} today
          </Text>
        )}
        {turn > 0 && (
          <Text color={theme.textMuted}>
            turn {turn}
          </Text>
        )}
        {tokenStr && <Text color={theme.textMuted}>{tokenStr}</Text>}
        <Text color={theme.textMuted}>tab:switch  ctrl+c:quit</Text>
      </Box>
    </Box>
  );
}
