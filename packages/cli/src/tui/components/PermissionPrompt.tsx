// Permission prompt — shown when a tool needs user approval

import React from "react";
import { Box, Text, useInput } from "ink";
import type { Theme } from "../themes/theme.js";

interface PermissionPromptProps {
  theme: Theme;
  tool: string;
  detail: string;
  onRespond: (response: "allow" | "deny" | "always_allow" | "always_deny") => void;
}

export function PermissionPrompt({
  theme,
  tool,
  detail,
  onRespond,
}: PermissionPromptProps) {
  useInput((input, key) => {
    switch (input.toLowerCase()) {
      case "y":
        onRespond("allow");
        break;
      case "n":
        onRespond("deny");
        break;
      case "a":
        onRespond("always_allow");
        break;
      case "d":
        onRespond("always_deny");
        break;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      paddingY={0}
    >
      <Text color={theme.warning} bold>
        Permission required
      </Text>
      <Box marginTop={0}>
        <Text color={theme.text}>
          <Text bold>{tool}</Text>: {detail}
        </Text>
      </Box>
      <Box marginTop={0} gap={2}>
        <Text color={theme.success}>[y]es</Text>
        <Text color={theme.error}>[n]o</Text>
        <Text color={theme.info}>[a]lways allow</Text>
        <Text color={theme.textMuted}>[d]eny forever</Text>
      </Box>
    </Box>
  );
}
