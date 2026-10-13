import { type IconWeight } from "@phosphor-icons/react";

// ============================================================================
// CORE DESIGN SYSTEM TYPES
// ============================================================================

// Enhanced color variant type with university-focused variants
export type ColorVariant =
  | "none"
  | "muted" // Darker contrast variant for better visual separation
  | "link"
  | "gradient" // Primary brand gradient
  | "blue"
  | "blue-gradient" // Blue gradient variant
  | "yellow"
  | "yellow-gradient" // Yellow gradient variant
  | "purple"
  | "purple-gradient" // Purple gradient variant (fallback to blue)
  | "green"
  | "green-gradient" // Green gradient variant (fallback to blue)
  | "orange"
  | "orange-gradient" // Orange gradient variant (fallback to yellow)
  | "metallic" // Metallic silver/gray variant for cards and surfaces
  | "mettalic-gradient" // Adaptive metallic gradient (light/dark)
  | "black" // Black variant for metallic gradient sections
  | "morphy" // High contrast variant (Black on Light, White on Dark)
  | "destructive" // Red/Danger variant
  | "multi";

// New effect type for component styling
export type ComponentEffect = "fill" | "glass" | "fade";

// Shared interactive props for Morphy-UX components
export interface MorphyInteractiveProps {
  /**
   * Visual variant for the component (gradient, muted, metallic, etc.).
   * Defaults are component-specific, but all map back to ColorVariant.
   */
  variant?: ColorVariant;
  /**
   * Surface treatment / physics preset.
   * - "fill": solid surface
   * - "glass": glassmorphism with backdrop blur
   * - "fade": low-emphasis surface with reduced blur
   */
  effect?: ComponentEffect;
  /**
   * Enables Material 3 ripple and state-layer interactions.
   */
  showRipple?: boolean;
}

// Base props for button-like components (used by Button)
export interface MorphyButtonBaseProps extends MorphyInteractiveProps {
  /**
   * Stretch the button to fill its container width.
   */
  fullWidth?: boolean;
  /**
   * Show a loading state and disable user interaction.
   */
  loading?: boolean;
}

// Base props for card/surface components
export interface MorphyCardBaseProps extends MorphyInteractiveProps {
  /**
   * Design-system preset for consistent radius/elevation without per-callsite className.
   * - "compact": small utility/summary cards
   * - "default": standard card surface
   * - "hero": large, neutral hero surface (e.g. onboarding previews)
   * - "surface": shared app data surface with standardized card chrome
   * - "surface-feature": shared app feature surface with slightly stronger depth
   */
  preset?: "compact" | "default" | "hero" | "surface" | "surface-feature";
  /**
   * Optional neutral highlight overlay for depth on glass cards.
   * This does not tint the outer card shell.
   */
  glassAccent?: "none" | "soft" | "balanced";
  /**
   * Marks the card as interactive (pointer cursor, hover affordances).
   */
  interactive?: boolean;
  /**
   * Highlights the card as selected.
   */
  selected?: boolean;
  /**
   * Stretches the card to fill the available height.
   */
  fullHeight?: boolean;
}

// ============================================================================
// DIRECTION & GRADIENT TYPES
// ============================================================================

export type GradientDirection =
  | "to-r"
  | "to-l"
  | "to-t"
  | "to-b"
  | "to-tr"
  | "to-tl"
  | "to-br"
  | "to-bl";

// ============================================================================
// ICON & UI TYPES
// ============================================================================

export type IconPosition =
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left";

export interface IconConfig {
  icon: React.ComponentType<{ className?: string; weight?: IconWeight }>;
  title?: string;
  position?: IconPosition;
}

// Feedback tones for alerts, toasts, and inline status messaging
export type FeedbackTone = "success" | "error" | "warning" | "info";

// ============================================================================
// COMPONENT VARIANT TYPES
// ============================================================================

export type ButtonVariant =
  | "link"
  | "gradient"
  | "blue"
  | "blue-gradient"
  | "purple"
  | "purple-gradient"
  | "green"
  | "green-gradient"
  | "orange"
  | "orange-gradient"
  | "metallic"
  | "multi";

export type CardVariant =
  | "none"
  | "muted" // Darker contrast variant
  | "gradient"
  | "blue"
  | "blue-gradient"
  | "purple"
  | "purple-gradient"
  | "green"
  | "green-gradient"
  | "orange"
  | "orange-gradient"
  | "metallic"
  | "multi";

// ============================================================================
// EFFECT PRESET TYPES
// ============================================================================

export type EffectPreset =
  | "material"
  | "glassmorphism"
  | "neumorphism"
  | "flat"
  | "gradient";

// ============================================================================
// RIPPLE TYPES
// ============================================================================

export interface RippleState {
  x: number;
  y: number;
  size: number;
}

export interface RippleProps {
  ripple: RippleState | null;
  color: string;
}

export interface RippleHookReturn {
  ripple: RippleState | null;
  isHovered: boolean;
  handleMouseEnter: (
    e: React.MouseEvent<HTMLElement>,
    ref: React.RefObject<HTMLElement>
  ) => void;
  handleMouseLeave: () => void;
  handleClick: (
    e: React.MouseEvent<HTMLElement>,
    ref: React.RefObject<HTMLElement>
  ) => void;
}
