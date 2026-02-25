// Theme system — inspired by OpenCode's multi-theme architecture

export interface Theme {
  name: string;

  // Core palette
  primary: string;
  secondary: string;
  accent: string;

  // Text
  text: string;
  textMuted: string;
  textBold: string;

  // Backgrounds
  bg: string;
  bgSecondary: string;
  bgHighlight: string;

  // Status
  success: string;
  warning: string;
  error: string;
  info: string;

  // Borders
  border: string;
  borderFocused: string;
  borderDim: string;

  // Syntax
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
}

const themes = new Map<string, Theme>();

export function registerTheme(theme: Theme): void {
  themes.set(theme.name, theme);
}

export function getTheme(name: string): Theme {
  return themes.get(name) || themes.get("cozyterm")!;
}

export function listThemes(): string[] {
  return Array.from(themes.keys());
}
