// Chat component — renders conversation messages with proper wrapping and scroll

import React from "react";
import { Box, Text, useStdout } from "ink";
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

/**
 * Estimate how many terminal lines a message will occupy.
 * Accounts for text wrapping at terminal width.
 */
function estimateLines(msg: ChatMessage, cols: number): number {
  const usable = Math.max(cols - 4, 20); // padding + prefix

  if (msg.role === "tool") {
    // Tool messages are truncated to 200 chars and indented
    const text = msg.content.length > 200
      ? msg.content.slice(0, 200) + "..."
      : msg.content;
    const prefix = msg.toolName ? `[${msg.toolName}] ` : "";
    return Math.ceil((prefix.length + text.length) / (usable - 2)) || 1;
  }

  if (msg.role === "user") {
    return Math.ceil((msg.content.length + 2) / usable) || 1;
  }

  // Assistant messages can be long — count by lines then wrapping
  const lines = msg.content.split("\n");
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil(line.length / usable));
  }
  return total + 1; // +1 for spacing
}

export function Chat({ theme, messages, height }: ChatProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const maxHeight = height || 30;

  // Walk backwards through messages, accumulating estimated line count
  // Stop when we've filled the viewport
  let linesUsed = 0;
  let startIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgLines = estimateLines(messages[i], cols);
    if (linesUsed + msgLines > maxHeight && startIndex < messages.length) {
      break;
    }
    linesUsed += msgLines;
    startIndex = i;
  }

  const visible = messages.slice(startIndex);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      overflow="hidden"
    >
      {startIndex > 0 && (
        <Text color={theme.textMuted} dimColor>
          {"  "}--- {startIndex} earlier messages ---
        </Text>
      )}
      {visible.map((msg, i) => (
        <MessageLine key={startIndex + i} theme={theme} message={msg} cols={cols} />
      ))}
    </Box>
  );
}

function MessageLine({
  theme,
  message,
  cols,
}: {
  theme: Theme;
  message: ChatMessage;
  cols: number;
}) {
  const maxWidth = Math.max(cols - 4, 20);

  switch (message.role) {
    case "user":
      return (
        <Box marginTop={1} width={maxWidth}>
          <Text color={theme.accent} bold wrap="truncate">
            {">"}{" "}
          </Text>
          <Box flexShrink={1}>
            <Text color={theme.text} wrap="wrap">
              {message.content}
            </Text>
          </Box>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1} width={maxWidth}>
          <AssistantContent theme={theme} content={message.content} />
          {message.isStreaming && (
            <Text color={theme.textMuted}> ...</Text>
          )}
        </Box>
      );

    case "tool":
      return (
        <Box marginLeft={2} width={maxWidth - 2}>
          <Text color={message.isError ? theme.error : theme.textMuted} wrap="wrap">
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

/**
 * Render assistant content with basic code block formatting.
 * Splits on ``` fences and applies different styles.
 */
function AssistantContent({ theme, content }: { theme: Theme; content: string }) {
  // Split on code fences
  const parts = content.split(/(```[\s\S]*?```)/g);

  if (parts.length === 1) {
    // No code blocks — just wrapped text
    return (
      <Text color={theme.primary} wrap="wrap">
        {content}
      </Text>
    );
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          // Code block — strip fences, show with different color
          const inner = part.slice(3, -3);
          // Remove optional language tag from first line
          const lines = inner.split("\n");
          const firstLine = lines[0].trim();
          const isLangTag = firstLine && !firstLine.includes(" ") && firstLine.length < 20;
          const code = isLangTag ? lines.slice(1).join("\n") : inner;

          return (
            <Box key={i} flexDirection="column" marginLeft={1} marginY={0}>
              {isLangTag && (
                <Text color={theme.textMuted} dimColor>
                  {firstLine}
                </Text>
              )}
              <Text color={theme.string} wrap="wrap">
                {code.trim()}
              </Text>
            </Box>
          );
        }

        // Regular text
        if (!part.trim()) return null;
        return (
          <Text key={i} color={theme.primary} wrap="wrap">
            {part}
          </Text>
        );
      })}
    </>
  );
}
