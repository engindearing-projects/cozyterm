// Editor component — input with ! bash shortcut and history

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Theme } from "../themes/theme.js";

interface EditorProps {
  theme: Theme;
  onSubmit: (text: string) => void;
  isLoading: boolean;
  placeholder?: string;
}

export function Editor({ theme, onSubmit, isLoading, placeholder }: EditorProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim() || isLoading) return;

      setHistory((prev) => [text, ...prev]);
      setHistoryIndex(-1);
      setValue("");
      onSubmit(text);
    },
    [isLoading, onSubmit],
  );

  useInput(
    (input, key) => {
      // Up arrow for history
      if (key.upArrow && history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setValue(history[newIndex]);
      }
      // Down arrow for history
      if (key.downArrow) {
        const newIndex = historyIndex - 1;
        if (newIndex < 0) {
          setHistoryIndex(-1);
          setValue("");
        } else {
          setHistoryIndex(newIndex);
          setValue(history[newIndex]);
        }
      }
    },
    { isActive: !isLoading },
  );

  return (
    <Box
      borderStyle="single"
      borderColor={isLoading ? theme.borderDim : theme.borderFocused}
      paddingX={1}
    >
      <Text color={theme.accent} bold>
        {isLoading ? "..." : ">"}{" "}
      </Text>
      {isLoading ? (
        <Text color={theme.textMuted}>thinking...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder || "ask anything, or ! for shell commands"}
        />
      )}
    </Box>
  );
}
