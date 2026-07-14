/**
 * Hussh brand color tokens.
 *
 * The runtime source of truth is the CSS variable layer in globals.css:
 * every accent-carrying token there resolves through the switchable
 * `--app-accent-*` family (iOS Blue default, Molten Gold under
 * html[data-accent="gold"]). TypeScript consumers should reference those
 * CSS variables (see `accentVariables` below), never literal accent hexes,
 * so surfaces follow the user's accent preference automatically.
 */

// =============================================================================
// APP ACCENT (CSS variable references — always correct for the live accent)
// =============================================================================

export const accentVariables = {
  accent: "var(--app-accent)",
  deep: "var(--app-accent-deep)",
  bright: "var(--app-accent-bright)",
  tint: "var(--app-accent-tint)",
  surface: "var(--app-accent-surface)",
  surfaceStrong: "var(--app-accent-surface-strong)",
  border: "var(--app-accent-border)",
  fg: "var(--app-accent-fg)",
  ring: "var(--app-accent-ring)",
} as const;

// =============================================================================
// NEUTRAL SILVER (accent-independent)
// =============================================================================

export const hushhColors = {
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
// MORPHY GRADIENT TOKENS (CSS-variable driven; follow the live accent)
// =============================================================================

export const morphyGradients = {
  primary: {
    css: "var(--morphy-primary-gradient)",
    tailwind:
      "from-[color:var(--morphy-primary-start)] to-[color:var(--morphy-primary-end)]",
  },
  secondary: {
    css: "var(--morphy-secondary-gradient)",
    tailwind:
      "from-[color:var(--morphy-secondary-start)] to-[color:var(--morphy-secondary-end)]",
  },
  accent: {
    css: "var(--morphy-accent-gradient)",
    tailwind:
      "from-[color:var(--morphy-accent-start)] to-[color:var(--morphy-accent-end)]",
  },
} as const;

// =============================================================================
// SEMANTIC COLORS (accent-independent)
// =============================================================================

export const semanticColors = {
  success: "#34C759", // Apple Green
  warning: "#FBBC05",
  error: "#EA4335",
  info: accentVariables.accent,
} as const;
