/**
 * Hussh brand color tokens
 *
 * Single source of truth for all morphy-ux colors.
 * Based on the Foundation gold palette (hushh design bible).
 *
 * NOTE: These tokens should match the CSS variables in globals.css
 * The CSS variables are the runtime source of truth.
 */

// =============================================================================
// PRIMARY BRAND COLORS - HUSHH (Foundation gold)
// =============================================================================

export const hushhColors = {
  // Primary - Foundation gold family (the `blue` key name is retained for
  // backward-compat with existing references; values are Foundation gold).
  blue: {
    50: "#FAF6F0",
    100: "#F7F1E8",
    200: "#EFE4D2",
    300: "#E8D8BF",
    400: "#D9B98A",
    500: "#D4A574", // Foundation gold accent
    600: "#B8894D", // Foundation gold deep
    700: "#9A7038",
    800: "#6F4F26",
    900: "#4A3418",
  },
  // Secondary - Extended Blue family
  secondary: {
    50: "#EFF6FF",
    100: "#DBEAFE",
    200: "#BFDBFE",
    300: "#93C5FD",
    400: "#D9B98A",
    500: "#C8995F", // Secondary gold
    600: "#B8894D",
    700: "#9A7038",
    800: "#6F4F26",
    900: "#4A3418",
  },
  // Neutral - Silver for subtle backgrounds
  silver: {
    50: "#FAFAFA",
    100: "#F5F5F5",
    200: "#E8E8E8",
    300: "#D4D4D4",
    400: "#C0C0C0",
    500: "#A3A3A3",
    600: "#737373",
    700: "#525252",
    800: "#404040",
    900: "#262626",
  },
} as const;

// =============================================================================
// MORPHY GRADIENT TOKENS
// =============================================================================

export const morphyGradients = {
  // Primary gradient (light mode) - Blue → Blue
  primary: {
    start: hushhColors.blue[500],
    end: hushhColors.secondary[500],
    css: `linear-gradient(to right, ${hushhColors.blue[500]}, ${hushhColors.secondary[500]})`,
    tailwind: "from-[#0071E3] to-[#3B82F6]",
  },
  // Secondary gradient - Silver (subtle backgrounds)
  secondary: {
    start: hushhColors.silver[400],
    end: hushhColors.silver[200],
    css: `linear-gradient(to right, ${hushhColors.silver[400]}, ${hushhColors.silver[200]})`,
    tailwind: "from-[#c0c0c0] to-[#e8e8e8]",
  },
  // Accent gradient (dark mode primary) - Light Blue
  accent: {
    start: "#60A5FA",
    end: "#3B82F6",
    css: "linear-gradient(to right, #60A5FA, #3B82F6)",
    tailwind: "from-[#60A5FA] to-[#3B82F6]",
  },
  // Multi (adapts to dark mode)
  multi: {
    light: "from-[#0071E3] to-[#3B82F6]",
    dark: "from-[#60A5FA] to-[#3B82F6]",
    tailwind:
      "from-[#0071E3] to-[#3B82F6] dark:from-[#60A5FA] dark:to-[#3B82F6]",
  },
} as const;

// =============================================================================
// SEMANTIC COLORS
// =============================================================================

export const semanticColors = {
  success: "#34C759", // Apple Green
  warning: "#FBBC05", // Google Yellow
  error: "#EA4335",   // Google Red
  info: hushhColors.blue[500],
} as const;

// =============================================================================
// CSS VARIABLE MAPPING
// These should match globals.css :root and .dark definitions
// =============================================================================

export const cssVariables = {
  // Light mode (default)
  light: {
    "--morphy-primary-start": hushhColors.blue[500],
    "--morphy-primary-end": hushhColors.secondary[500],
    "--morphy-secondary-start": hushhColors.silver[400],
    "--morphy-secondary-end": hushhColors.silver[200],
  },
  // Dark mode
  dark: {
    "--morphy-primary-start": "#60A5FA",
    "--morphy-primary-end": "#3B82F6",
    "--morphy-secondary-start": "#60A5FA",
    "--morphy-secondary-end": "#3B82F6",
  },
} as const;
