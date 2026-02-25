// CozyTerm default theme — warm, inviting, easy on the eyes
// Think coffee shop vibes: warm ambers, soft creams, rich browns

import { registerTheme } from "./theme.js";
import type { Theme } from "./theme.js";

export const cozyTheme: Theme = {
  name: "cozyterm",

  // Warm amber/gold palette
  primary: "#E8A87C",     // Warm peach
  secondary: "#D4A574",   // Soft tan
  accent: "#F4C95D",      // Golden amber

  // Cream/warm text
  text: "#F5E6D3",        // Warm cream
  textMuted: "#9B8B7A",   // Muted brown
  textBold: "#FFECD2",    // Bright cream

  // Rich dark backgrounds
  bg: "#1A1410",          // Deep espresso
  bgSecondary: "#241E18", // Dark walnut
  bgHighlight: "#2E261E", // Highlighted brown

  // Status colors (warm-shifted)
  success: "#95C77E",     // Sage green
  warning: "#F4C95D",     // Golden amber
  error: "#E07A5F",       // Terra cotta
  info: "#81B2D9",        // Soft blue

  // Borders
  border: "#3D3429",      // Dark brown
  borderFocused: "#E8A87C", // Warm peach (matches primary)
  borderDim: "#2A231C",   // Very dark brown

  // Syntax highlighting (warm-shifted)
  keyword: "#E8A87C",     // Peach
  string: "#95C77E",      // Sage
  number: "#F4C95D",      // Amber
  comment: "#6B5D4E",     // Muted brown
  function: "#81B2D9",    // Soft blue
};

registerTheme(cozyTheme);
