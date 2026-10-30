/**
 * Morphy-UX
 * 
 * A self-contained, portable physics-based UI library for React + Tailwind.
 * Built for the Hussh agent platform.
 * 
 * @example
 * import { cn, useRipple, hushhColors, morphyGradients } from "@/lib/morphy-ux";
 */

// Core utilities
export { cn } from "./cn";

// Ripple physics
export { useRipple, Ripple, rippleKeyframes } from "./ripple";

// Design tokens
export * from "./tokens";

// Variant styles and utilities
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

// Types
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

// GSAP animations
export * from "./gsap";
export * from "./gsap-init";

// Motion presets (GSAP-based)
export * from "./motion";

// Surface primitives
export * from "./surfaces";

// Icon utilities
export { useIconWeight } from "./icon-theme-context";
export * from "./icon-utils";

// Streaming components (ChatGPT/Perplexity-style)
export { useStreamingText } from "./hooks/use-streaming-text";
export type {
  UseStreamingTextOptions,
  UseStreamingTextReturn,
} from "./hooks/use-streaming-text";
export { StreamingCursor } from "./streaming-cursor";
export type { StreamingCursorProps } from "./streaming-cursor";
export { StreamingTextDisplay } from "./streaming-text";
export type { StreamingTextDisplayProps } from "./streaming-text";
export {
  ThinkingIndicator,
  StreamingStageIndicator,
} from "./thinking-indicator";
export type {
  ThinkingIndicatorProps,
  StreamingStageIndicatorProps,
} from "./thinking-indicator";
