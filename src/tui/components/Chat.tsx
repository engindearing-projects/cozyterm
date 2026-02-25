// Chat component — renders conversation messages and tool calls

import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../themes/theme.js";

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
  isError?: boolean;
  isStreaming?: boolean;
}

interface ChatProps {
  theme: Theme;
  messages: ChatMessage[];
  height?: number;
}

export function Chat({ theme, messages, height }: ChatProps) {
  // Show the last N messages that fit
  const visible = height ? messages.slice(-(height - 2)) : messages;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((msg, i) => (
        <MessageLine key={i} theme={theme} message={msg} />
      ))}
    </Box>
  );
}

function MessageLine({
  theme,
  message,
}: {
  theme: Theme;
  message: ChatMessage;
}) {
  switch (message.role) {
    case "user":
      return (
        <Box marginY={0}>
          <Text color={theme.accent} bold>
            {">"}{" "}
          </Text>
          <Text color={theme.text}>{message.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginY={0}>
          <Text color={theme.primary}>
            {message.content}
            {message.isStreaming ? (
              <Text color={theme.textMuted}> ...</Text>
            ) : null}
          </Text>
        </Box>
      );

    case "tool":
      return (
        <Box marginLeft={2}>
          <Text color={message.isError ? theme.error : theme.textMuted}>
            {message.toolName ? `[${message.toolName}] ` : ""}
            {message.content.length > 200
              ? message.content.slice(0, 200) + "..."
              : message.content}
          </Text>
        </Box>
      );

    default:
      return null;
  }
}
