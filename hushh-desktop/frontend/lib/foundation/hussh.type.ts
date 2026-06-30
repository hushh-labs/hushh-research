// hussh.type.ts - type system - Foundation v1.0
// SF Pro via the system stack only. Do not bundle or @font-face Apple fonts.

export const fontFamily = {
  display: 'SF Pro Display, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  text: 'SF Pro Text, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
} as const;

export const weight = { regular: "400", semibold: "600", bold: "700" } as const;

export const type = {
  display: { size: 34, weight: 700, line: 36, tracking: -0.75 },
  title1: { size: 28, weight: 700, line: 31, tracking: -0.56 },
  title2: { size: 22, weight: 600, line: 26, tracking: -0.35 },
  title3: { size: 20, weight: 600, line: 24, tracking: -0.24 },
  headline: { size: 17, weight: 600, line: 22, tracking: -0.17 },
  body: { size: 17, weight: 400, line: 25, tracking: 0 },
  callout: { size: 16, weight: 400, line: 23, tracking: 0 },
  subhead: { size: 15, weight: 400, line: 21, tracking: 0 },
  footnote: { size: 13, weight: 400, line: 18, tracking: 0 },
  caption: { size: 12, weight: 600, line: 16, tracking: 1.9, upper: true },
  micro: { size: 11, weight: 600, line: 14, tracking: 2.2, upper: true },
} as const;

export const maxFontScale = {
  display: 1.3,
  title1: 1.3,
  title2: 1.3,
  title3: 1.3,
  headline: 1.4,
  body: 1.6,
  callout: 1.6,
  subhead: 1.6,
  footnote: 1.7,
  caption: 1.7,
  micro: 1.7,
} as const;

export const webType = {
  display: "clamp(2.125rem, 1.55rem + 2.3vw, 3.5rem)",
  title1: "clamp(1.75rem, 1.46rem + 1.2vw, 2.5rem)",
  title2: "clamp(1.375rem, 1.25rem + 0.5vw, 1.75rem)",
  title3: "clamp(1.25rem, 1.18rem + 0.3vw, 1.375rem)",
} as const;

export const breakpoint = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const;
export const maxContentWidth = 960;

export const light = {
  bg: "#FFFFFF",
  bgGrouped: "#F5F5F7",
  surface: "#FFFFFF",
  surface2: "#F5F5F7",
  hairline: "#E5E5EA",
  text: "#1D1D1F",
  textSecondary: "#6E6E73",
  textTertiary: "#86868B",
  gold: "#B8894D",
  goldDeep: "#B8894D",
  action: "#000000",
  actionText: "#FFFFFF",
} as const;

export const dark = {
  bg: "#000000",
  bgGrouped: "#0A0A0A",
  surface: "#1C1C1E",
  surface2: "#2C2C2E",
  hairline: "#2C2C2E",
  text: "#F5F5F7",
  textSecondary: "#AEAEB2",
  textTertiary: "#8E8E93",
  gold: "#D4A574",
  goldDeep: "#C79A5E",
  action: "#FFFFFF",
  actionText: "#000000",
} as const;

export const palette = { light, dark } as const;
export type Scheme = keyof typeof palette;
export type TypeRole = keyof typeof type;

export const GOLD_PERIOD = "var(--foundation-gold)";
