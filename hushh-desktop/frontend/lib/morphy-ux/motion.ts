// =============================================================================
// Morphy Motion Tokens (Material 3 expressive inspired)
// =============================================================================

export const motionDurations = {
  // Enter/exit – tuned for mobile-first responsiveness
  xs: 120,
  sm: 180,
  md: 240,
  lg: 320,
  xl: 450,
  // Long sequences / marquee fallbacks
  xxl: 600,
} as const;

export type MotionDurationKey = keyof typeof motionDurations;

export const motionEasings = {
  // Standard Material-like curve
  standard: "cubic-bezier(0.2, 0.0, 0.0, 1)",
  // Acceleration / deceleration variants
  accelerate: "cubic-bezier(0.3, 0.0, 1, 1)",
  decelerate: "cubic-bezier(0.0, 0.0, 0.2, 1)",
  emphasized: "cubic-bezier(0.2, 0.0, 0, 1)",
} as const;

export type MotionEasingKey = keyof typeof motionEasings;

export const motionDistances = {
  // Translate distances for enter transitions
  tiny: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
} as const;

export type MotionDistanceKey = keyof typeof motionDistances;

export const motionOpacity = {
  from: 0.0,
  to: 1.0,
} as const;

export const motionDefaults = {
  durationMs: motionDurations.md,
  easing: motionEasings.emphasized,
  distancePx: motionDistances.md,
} as const;

// -----------------------------------------------------------------------------
// Runtime motion vars (client-only)
// -----------------------------------------------------------------------------

function parseCssNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function parseCssBezier(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  // Accept either "cubic-bezier(...)" or "0.2,0,0,1"
  if (v.startsWith("cubic-bezier(") || /^[0-9.\s,]+$/.test(v)) return v;
  return null;
}

export function getMotionCssVars(): {
  durationsMs: Record<MotionDurationKey, number>;
  easings: Record<MotionEasingKey, string>;
  pageEnterDurationMs: number;
  deckDurationMs: number;
  deckScales: { active: number; adjacent: number; other: number };
} {
  // SSR-safe fallback
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      durationsMs: motionDurations,
      easings: motionEasings,
      pageEnterDurationMs: motionDurations.xl,
      deckDurationMs: motionDurations.xl,
      deckScales: { active: 1.14, adjacent: 0.9, other: 0.84 },
    };
  }

  const style = getComputedStyle(document.documentElement);

  const durationsMs = {
    xs: parseCssNumber(style.getPropertyValue("--motion-duration-xs")) ?? motionDurations.xs,
    sm: parseCssNumber(style.getPropertyValue("--motion-duration-sm")) ?? motionDurations.sm,
    md: parseCssNumber(style.getPropertyValue("--motion-duration-md")) ?? motionDurations.md,
    lg: parseCssNumber(style.getPropertyValue("--motion-duration-lg")) ?? motionDurations.lg,
    xl: parseCssNumber(style.getPropertyValue("--motion-duration-xl")) ?? motionDurations.xl,
    xxl: parseCssNumber(style.getPropertyValue("--motion-duration-xxl")) ?? motionDurations.xxl,
  };

  const easings = {
    standard:
      parseCssBezier(style.getPropertyValue("--motion-ease-standard")) ??
      motionEasings.standard,
    accelerate:
      parseCssBezier(style.getPropertyValue("--motion-ease-accelerate")) ??
      motionEasings.accelerate,
    decelerate:
      parseCssBezier(style.getPropertyValue("--motion-ease-decelerate")) ??
      motionEasings.decelerate,
    emphasized:
      parseCssBezier(style.getPropertyValue("--motion-ease-emphasized")) ??
      motionEasings.emphasized,
  };

  const pageEnterDurationMs =
    parseCssNumber(style.getPropertyValue("--motion-page-enter-duration")) ??
    durationsMs.xl;
  const deckDurationMs =
    parseCssNumber(style.getPropertyValue("--motion-deck-duration")) ??
    durationsMs.xl;

  const deckScales = {
    active:
      parseCssNumber(style.getPropertyValue("--motion-deck-scale-active")) ??
      1.14,
    adjacent:
      parseCssNumber(style.getPropertyValue("--motion-deck-scale-adjacent")) ??
      0.9,
    other:
      parseCssNumber(style.getPropertyValue("--motion-deck-scale-other")) ?? 0.84,
  };

  return {
    durationsMs,
    easings,
    pageEnterDurationMs,
    deckDurationMs,
    deckScales,
  };
}

export const motionVariants = {
  // Shared axis Y (enter from below)
  enterFromBottom: {
    y: motionDistances.lg,
    opacity: motionOpacity.from,
  },
  // Fade only
  fadeIn: {
    y: 0,
    opacity: motionOpacity.from,
  },
  // Slight scale for elevation emphasis
  elevate: {
    scale: 0.98,
    opacity: motionOpacity.from,
  },
} as const;

export type MotionVariantKey = keyof typeof motionVariants;
