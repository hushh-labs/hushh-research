// ============================================================================
// MORPHY-UI MAIN ENTRY POINT - UNIVERSITY FOCUSED
// ============================================================================

// Core types
export type {
  ColorVariant,
  ComponentEffect,
  GradientDirection,
  IconPosition,
  IconConfig,
  ButtonVariant,
  CardVariant,
  EffectPreset,
  RippleState,
  RippleProps,
  RippleHookReturn,
} from "./types";

// Material 3 Expressive Ripple (primary)
export { MaterialRipple, getMaterialRippleColors } from "./material-ripple";

// Legacy ripple (deprecated - use MaterialRipple instead)
export { useRipple, Ripple, rippleKeyframes } from "./ripple";

// Icon system
export { useIconWeight } from "./icon-theme-context";

export { IconWrapper, useGlobalIconWeight } from "./icon-utils";

// Social icons
export {
  GoogleIcon,
  AppleIcon,
  InstagramIcon,
  SocialIcons,
} from "./social-icons";

// Toast utilities
export { useMorphyToast, morphyToast } from "./toast-utils";

// Utilities
export {
  gradientPresets,
  getVariantStyles,
  getVariantStylesNoHover,
  getIconColor,
  getRippleColor,
  createGradient,
  getVariantGradient,
  getRippleGradient,
  glassEffect,
  opacityTransitions,
  opacityStates,
  createOpacityTransition,
} from "./utils";

// Components with Morphy Extensions
export { Button, buttonVariants } from "./button";
export type { ButtonProps } from "./button";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./card";
export type { CardProps } from "./card";

// ============================================================================
// UNIVERSITY TYPOGRAPHY SYSTEM (CENTRALIZED)
// All typography classes must be referenced via this object.
// Headings: Inter (.font-heading)
// Body: Geist Sans (.font-sans)
// Font families are defined in globals.css, classes are referenced here.
// ============================================================================

export const typography = {
  // Font weights
  weights: {
    thin: "font-thin",
    light: "font-light",
    normal: "font-normal",
    medium: "font-medium",
    semibold: "font-semibold",
    bold: "font-bold",
    extrabold: "font-extrabold",
    black: "font-black",
  },
  // Font sizes with line heights
  sizes: {
    xs: ["0.75rem", { lineHeight: "1rem" }],
    sm: ["0.875rem", { lineHeight: "1.25rem" }],
    base: ["1rem", { lineHeight: "1.5rem" }],
    lg: ["1.125rem", { lineHeight: "1.75rem" }],
    xl: ["1.25rem", { lineHeight: "1.75rem" }],
    "2xl": ["1.5rem", { lineHeight: "2rem" }],
    "3xl": ["1.875rem", { lineHeight: "2.25rem" }],
    "4xl": ["2.25rem", { lineHeight: "2.5rem" }],
    "5xl": ["3rem", { lineHeight: "1" }],
    "6xl": ["3.75rem", { lineHeight: "1" }],
    "7xl": ["4.5rem", { lineHeight: "1" }],
    "8xl": ["6rem", { lineHeight: "1" }],
    "9xl": ["8rem", { lineHeight: "1" }],
  },
  // Typography classes
  classes: {
    heading: "font-heading",
    body: "font-sans",
    display: "font-heading",
  },
} as const;

// ============================================================================
// CENTRALIZED COLOR TOKEN SYSTEM
// Single source of truth for all colors - change here to update globally
// ============================================================================

export const colorTokens = {
  // Primary brand colors - Hussh Blue→Purple gradient (light mode)
  // In dark mode, CSS variables switch to yellow→orange automatically
  primary: {
    start: "#0071e3", // Hussh Blue
    end: "#bb62fc", // Hussh Purple
  },
  // Secondary colors - Silver for subtle backgrounds (FAQ style)
  secondary: {
    start: "#c0c0c0",
    end: "#e8e8e8",
  },
  // Accent colors - Gold/Yellow (used in dark mode as primary)
  accent: {
    start: "#fbbf24",
    end: "#f59e0b",
  },
  // Opacity variants for backgrounds/borders
  opacity: {
    low: "10",
    medium: "20",
    high: "30",
  },
} as const;

// ============================================================================
// CSS CUSTOM PROPERTIES GENERATOR
// Automatically generates CSS variables from tokens
// ============================================================================

export const generateColorCSS = () => `
  :root {
    --morphy-primary-start: ${colorTokens.primary.start};
    --morphy-primary-end: ${colorTokens.primary.end};
    --morphy-secondary-start: ${colorTokens.secondary.start};
    --morphy-secondary-end: ${colorTokens.secondary.end};
  }

  .dark {
    --morphy-primary-start: ${colorTokens.secondary.start};
    --morphy-primary-end: ${colorTokens.secondary.end};
    --morphy-secondary-start: ${colorTokens.primary.start};
    --morphy-secondary-end: ${colorTokens.primary.end};
  }
`;

// ============================================================================
// UTILITY FUNCTIONS - CENTRALIZED CLASS GENERATION
// Use these instead of hardcoded color strings
// ============================================================================

export const getGradientClasses = (
  variant: "primary" | "secondary" = "primary"
) => {
  return `bg-gradient-to-r from-[var(--morphy-${variant}-start)] to-[var(--morphy-${variant}-end)]`;
};

export const getColorClass = (
  variant: "primary" | "secondary" = "primary",
  type: "start" | "end" = "start"
) => {
  return `text-[var(--morphy-${variant}-${type})]`;
};

export const getBackgroundClass = (
  variant: "primary" | "secondary" = "primary",
  opacity: keyof typeof colorTokens.opacity = "medium"
) => {
  return `bg-[var(--morphy-${variant}-start)]/${colorTokens.opacity[opacity]}`;
};

export const getBorderClass = (
  variant: "primary" | "secondary" = "primary",
  opacity: keyof typeof colorTokens.opacity = "medium"
) => {
  return `border-[var(--morphy-${variant}-start)]/${colorTokens.opacity[opacity]}`;
};

export const getBadgeClasses = (
  variant: "primary" | "secondary" = "primary",
  size: "sm" | "md" = "sm"
) => {
  const sizeClasses =
    size === "sm" ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5";

  return `${sizeClasses} rounded-full bg-gradient-to-r from-[var(--morphy-${variant}-start)]/20 to-[var(--morphy-${variant}-end)]/20 dark:from-[var(--morphy-${
    variant === "primary" ? "secondary" : "primary"
  }-start)]/20 dark:to-[var(--morphy-${
    variant === "primary" ? "secondary" : "primary"
  }-end)]/20 border border-[var(--morphy-${variant}-start)]/30 dark:border-[var(--morphy-${
    variant === "primary" ? "secondary" : "primary"
  }-start)]/30 text-[var(--morphy-${variant}-start)] dark:text-[var(--morphy-${
    variant === "primary" ? "secondary" : "primary"
  }-start)] w-fit`;
};

// ============================================================================
// BACKWARD COMPATIBILITY - LEGACY COLOR PALETTE
// ============================================================================

export const colors = {
  // Primary blue palette (professional, trustworthy)
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#13405d", // Primary brand blue
    600: "#0d7590", // Secondary blue
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
  },

  // Accent yellow palette (energy, optimism)
  yellow: {
    50: "#fefce8",
    100: "#fef3c7",
    200: "#fde68a",
    300: "#fcd34d",
    400: "#fbbf24", // Primary brand yellow
    500: "#f59e0b", // Secondary yellow
    600: "#d97706",
    700: "#b45309",
    800: "#92400e",
    900: "#78350f",
  },

  // Neutral grays for content
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },
} as const;

// ============================================================================
// UNIVERSITY GRADIENT SYSTEM
// ============================================================================

export const gradients = {
  // Primary university gradient - blue to blue (professional)
  primary: "from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)]",

  // Secondary university gradient - yellow to yellow (accent)
  secondary:
    "from-[var(--morphy-secondary-start)] to-[var(--morphy-secondary-end)]",

  // Brand gradient - blue to blue (light mode) / yellow to yellow (dark mode)
  brand: "from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)]",

  // Light mode gradients
  light: {
    blue: "from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)]",
    yellow:
      "from-[var(--morphy-secondary-start)] to-[var(--morphy-secondary-end)]",
  },

  // Dark mode gradients
  dark: {
    blue: "from-[var(--morphy-primary-end)] to-[var(--morphy-primary-start)]",
    yellow:
      "from-[var(--morphy-secondary-end)] to-[var(--morphy-secondary-start)]",
  },
} as const;

// ============================================================================
// UNIVERSITY ANIMATION SYSTEM
// ============================================================================

export const animations = {
  ripple: {
    keyframes: {
      "0%": { transform: "scale(0)", opacity: "1" },
      "100%": { transform: "scale(4)", opacity: "0" },
    },
    duration: "0.6s",
    timing: "linear",
  },
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const getTypographyClass = (type: keyof typeof typography.classes) => {
  return typography.classes[type];
};

export const getLegacyColorClass = (
  color: keyof typeof colors,
  shade: keyof typeof colors.blue
) => {
  return `text-[${colors[color][shade]}]`;
};

export const getGradientClass = (gradient: keyof typeof gradients) => {
  return `bg-gradient-to-r ${gradients[gradient]}`;
};

export const getAnimationClass = (animation: keyof typeof animations) => {
  const anim = animations[animation];
  return `animate-[${animation}_${anim.duration}_${anim.timing}]`;
};
