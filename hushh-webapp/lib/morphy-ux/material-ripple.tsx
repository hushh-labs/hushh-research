"use client";

/**
 * Material 3 Ripple Integration for Morphy-UX
 *
 * This wrapper integrates @material/web ripple with Morphy-UX props system.
 * Blends iOS glass aesthetics with Material 3 Expressive physics.
 *
 * Features:
 * - Material 3 spring-based ripple animations
 * - Morphy-UX variant color mapping
 * - Effect-based opacity control (glass/fade = subtle, fill = standard)
 * - Dark mode: Silver accents for Hussh brand
 * - Reduced motion: an opacity-only press layer replaces the growing ripple
 */

import React, { useEffect, useRef, useState } from "react";
import { type ColorVariant, type ComponentEffect } from "./types";

// ============================================================================
// TYPES - MdRipple interface is now in global.d.ts
// ============================================================================

interface MdRipple extends HTMLElement {
  disabled: boolean;
  attach?: (control: HTMLElement) => void;
  detach?: () => void;
}

const INTERACTIVE_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input[type='button']",
  "input[type='submit']",
  "input[type='reset']",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='checkbox']",
].join(", ");

// Material Web releases a touch press on `click`, rather than `pointerup`.
// Safari/WKWebView can suppress that click if a fixed ancestor moved during the
// gesture. This is deliberately longer than a normal synthesized click, so the
// regular Material 3 release animation remains untouched.
const MISSING_TOUCH_CLICK_RESET_MS = 700;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// The flat press layer's fade. Kept inside the 150ms press budget so a
// reduced-motion press still reads as immediate.
const FLAT_PRESS_FADE_MS = 100;

/**
 * The reduced-motion query list, or null where the host has none. Some
 * embedded engines and test doubles return nothing from matchMedia; the
 * ripple must degrade to its full-motion default there, never throw.
 */
function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY) ?? null;
}

/**
 * md-ripple grows a radial layer with a transform animation and has no
 * reduced-motion mode of its own. People who ask the system for less motion
 * get a flat, opacity-only press layer instead; everyone else keeps the
 * Material ripple from the pointerdown point.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const onChange = () => setReduced(Boolean(query.matches));
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

function resolveRippleControl(container: HTMLDivElement): HTMLElement {
  return (
    container.closest<HTMLElement>(INTERACTIVE_CONTROL_SELECTOR) ??
    container.parentElement ??
    container
  );
}

// ============================================================================
// COLOR MAPPING - Morphy Variants to Material 3 Tokens
// ============================================================================

export const getMaterialRippleColors = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill",
  isDarkMode: boolean = false,
): {
  hoverColor: string;
  pressedColor: string;
  hoverOpacity: number;
  pressedOpacity: number;
} => {
  // Base opacity - glass/fade are more subtle; fill needs to be more visible on solid/gradient surfaces.
  const baseOpacity =
    effect === "glass" || effect === "fade"
      ? { hover: 0.06, pressed: 0.1 }
      : { hover: 0.1, pressed: 0.16 };

  // For fill buttons, use currentColor so the ripple contrasts with the label color
  // (white in light mode for gradients, black in dark mode where Morphy flips text).
  if (effect === "fill") {
    return {
      hoverColor: "currentColor",
      pressedColor: "currentColor",
      hoverOpacity: baseOpacity.hover,
      pressedOpacity: baseOpacity.pressed,
    };
  }

  // Dark mode uses silver for Hussh brand (glass/fade only).
  if (isDarkMode) {
    return {
      hoverColor: "#c0c0c0",
      pressedColor: "#e8e8e8",
      hoverOpacity: baseOpacity.hover,
      pressedOpacity: baseOpacity.pressed,
    };
  }

  // Light mode / fill effect color mapping
  switch (variant) {
    case "gradient":
    case "blue":
    case "blue-gradient":
    case "multi":
      return {
        hoverColor: "var(--app-accent)",
        pressedColor: "var(--app-accent)",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "yellow":
    case "yellow-gradient":
      return {
        hoverColor: "#fbbf24",
        pressedColor: "#f59e0b",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "purple":
    case "purple-gradient":
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "#7c3aed",
        pressedColor: isDarkMode ? "#e8e8e8" : "#6d28d9",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "green":
    case "green-gradient":
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "#10b981",
        pressedColor: isDarkMode ? "#e8e8e8" : "#059669",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "orange":
    case "orange-gradient":
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "#f59e0b",
        pressedColor: isDarkMode ? "#e8e8e8" : "#d97706",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "metallic":
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "#9ca3af",
        pressedColor: isDarkMode ? "#e8e8e8" : "#6b7280",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "black":
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "#000000",
        pressedColor: isDarkMode ? "#e8e8e8" : "#1f2937",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
    case "none":
    case "link":
    default:
      return {
        hoverColor: isDarkMode ? "#c0c0c0" : "currentColor",
        pressedColor: isDarkMode ? "#e8e8e8" : "currentColor",
        hoverOpacity: baseOpacity.hover,
        pressedOpacity: baseOpacity.pressed,
      };
  }
};

// ============================================================================
// MATERIAL RIPPLE COMPONENT
// ============================================================================

interface MaterialRippleProps {
  variant?: ColorVariant;
  effect?: ComponentEffect;
  disabled?: boolean;
  className?: string;
  /** Keep the press ripple but suppress a second hover layer owned by the parent. */
  disableHover?: boolean;
}

export const MaterialRipple = ({
  variant = "gradient",
  effect = "fill",
  disabled = false,
  className = "",
  disableHover = false,
}: MaterialRippleProps) => {
  const rippleRef = useRef<MdRipple>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRippleReady, setIsRippleReady] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const [flatPressed, setFlatPressed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const ensureRippleElement = async () => {
      if (typeof window === "undefined") return;

      if (customElements.get("md-ripple")) {
        if (!cancelled) setIsRippleReady(true);
        return;
      }

      try {
        await import("@material/web/ripple/ripple.js");
        if (!cancelled) {
          setIsRippleReady(Boolean(customElements.get("md-ripple")));
        }
      } catch (error) {
        console.warn(
          "[MaterialRipple] Material Web ripple is unavailable. Rendering without the custom ripple element.",
          error,
        );
        if (!cancelled) setIsRippleReady(false);
      }
    };

    void ensureRippleElement();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      reducedMotion ||
      !isRippleReady ||
      !containerRef.current ||
      rippleRef.current
    ) {
      return;
    }

    const rippleElement = document.createElement("md-ripple") as MdRipple;
    rippleElement.className = "morphy-md-ripple";
    rippleElement.disabled = disabled;
    containerRef.current.appendChild(rippleElement);
    rippleElement.attach?.(resolveRippleControl(containerRef.current));
    rippleRef.current = rippleElement;

    return () => {
      rippleElement.detach?.();
      if (rippleRef.current === rippleElement) {
        rippleRef.current = null;
      }
      rippleElement.remove();
    };
  }, [disabled, isRippleReady, reducedMotion]);

  // Reduced motion: a flat state layer that fades in on pointerdown and out on
  // release. No transform, no growth, no origin point.
  useEffect(() => {
    const container = containerRef.current;
    if (!reducedMotion || disabled || !container) {
      setFlatPressed(false);
      return;
    }
    const control = resolveRippleControl(container);
    const press = (event: PointerEvent) => {
      // Only an explicit secondary pointer or a non-primary mouse button is
      // ignored; engines that omit the field still press.
      if (event.isPrimary === false) return;
      if (event.pointerType === "mouse" && event.button > 0) return;
      setFlatPressed(true);
    };
    const release = () => setFlatPressed(false);
    const releaseEvents = [
      "pointerup",
      "pointercancel",
      "pointerleave",
      "touchcancel",
      "dragstart",
    ] as const;

    control.addEventListener("pointerdown", press);
    for (const type of releaseEvents) {
      control.addEventListener(type, release);
    }
    window.addEventListener("blur", release);

    return () => {
      control.removeEventListener("pointerdown", press);
      for (const type of releaseEvents) {
        control.removeEventListener(type, release);
      }
      window.removeEventListener("blur", release);
    };
  }, [disabled, reducedMotion]);

  useEffect(() => {
    if (rippleRef.current) {
      rippleRef.current.disabled = disabled;
    }
  }, [disabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!isRippleReady || !container) return;
    const control = resolveRippleControl(container);

    let resetFrame: number | undefined;
    let missingClickTimer: number | undefined;
    const clearInterruptedPress = () => {
      const ripple = rippleRef.current;
      if (!ripple || disabled) return;

      // Material Web listens for pointercancel, but iOS WKWebView may surface
      // an interrupted long press as touchcancel only. Toggle disabled across
      // frames so Lit commits `pressed = false` without intercepting the
      // control's tap or shortening a normal pointerup/click ripple.
      ripple.disabled = true;
      if (resetFrame !== undefined) {
        window.cancelAnimationFrame(resetFrame);
      }
      resetFrame = window.requestAnimationFrame(() => {
        if (rippleRef.current === ripple && !disabled) {
          ripple.disabled = false;
        }
      });
    };
    const clearMissingClickReset = () => {
      if (missingClickTimer === undefined) return;
      window.clearTimeout(missingClickTimer);
      missingClickTimer = undefined;
    };
    const scheduleMissingClickReset = (event: Event) => {
      // Mouse and pen input reliably produces a click. Keep their normal
      // Material release path intact; this is a WebKit touch fallback only.
      if (
        event.type === "pointerup" &&
        "pointerType" in event &&
        (event as PointerEvent).pointerType !== "touch"
      ) {
        return;
      }

      clearMissingClickReset();
      missingClickTimer = window.setTimeout(() => {
        missingClickTimer = undefined;
        clearInterruptedPress();
      }, MISSING_TOUCH_CLICK_RESET_MS);
    };
    const clearWhenHidden = () => {
      if (document.visibilityState !== "visible") {
        clearInterruptedPress();
      }
    };

    control.addEventListener("pointercancel", clearInterruptedPress, true);
    control.addEventListener("touchcancel", clearInterruptedPress, true);
    control.addEventListener("pointerup", scheduleMissingClickReset, true);
    control.addEventListener("touchend", scheduleMissingClickReset, true);
    control.addEventListener("click", clearMissingClickReset, true);
    window.addEventListener("blur", clearInterruptedPress);
    document.addEventListener("visibilitychange", clearWhenHidden);

    return () => {
      control.removeEventListener("pointercancel", clearInterruptedPress, true);
      control.removeEventListener("touchcancel", clearInterruptedPress, true);
      control.removeEventListener("pointerup", scheduleMissingClickReset, true);
      control.removeEventListener("touchend", scheduleMissingClickReset, true);
      control.removeEventListener("click", clearMissingClickReset, true);
      window.removeEventListener("blur", clearInterruptedPress);
      document.removeEventListener("visibilitychange", clearWhenHidden);
      clearMissingClickReset();
      if (resetFrame !== undefined) {
        window.cancelAnimationFrame(resetFrame);
      }
    };
  }, [disabled, isRippleReady]);

  useEffect(() => {
    // Check for dark mode
    const isDarkMode = document.documentElement.classList.contains("dark");

    // Get colors based on variant and effect
    const colors = getMaterialRippleColors(variant, effect, isDarkMode);

    // Apply Material 3 tokens via CSS custom properties
    if (containerRef.current) {
      containerRef.current.style.setProperty(
        "--md-ripple-hover-color",
        colors.hoverColor,
      );
      containerRef.current.style.setProperty(
        "--md-ripple-pressed-color",
        colors.pressedColor,
      );
      containerRef.current.style.setProperty(
        "--md-ripple-hover-opacity",
        String(disableHover ? 0 : colors.hoverOpacity),
      );
      containerRef.current.style.setProperty(
        "--md-ripple-pressed-opacity",
        String(colors.pressedOpacity),
      );
    }
  }, [disableHover, effect, variant]);

  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class") {
          const isDarkMode =
            document.documentElement.classList.contains("dark");
          const colors = getMaterialRippleColors(variant, effect, isDarkMode);

          if (containerRef.current) {
            containerRef.current.style.setProperty(
              "--md-ripple-hover-color",
              colors.hoverColor,
            );
            containerRef.current.style.setProperty(
              "--md-ripple-pressed-color",
              colors.pressedColor,
            );
          }
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [variant, effect]);

  return (
    <div
      ref={containerRef}
      data-ripple-mode={reducedMotion ? "flat" : "material"}
      className={`morphy-ripple-host pointer-events-none absolute inset-0 isolate overflow-hidden ${className}`}
      // Let the ripple host own the clip boundary for rounded actionables.
      // pointer-events:none is critical: the host overlays the actionable's
      // content (absolute inset-0). On iOS WKWebView an overlay without it can
      // swallow the first tap, which surfaced as "bottom nav needs a double tap
      // / never switches". The ripple is purely visual; the parent button still
      // receives the pointer events md-ripple observes.
      style={{
        borderRadius: "inherit",
        contain: "paint",
        pointerEvents: "none",
      }}
    >
      {reducedMotion ? (
        <span
          aria-hidden="true"
          data-ripple-flat=""
          data-pressed={flatPressed ? "true" : undefined}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "inherit",
            pointerEvents: "none",
            backgroundColor: "var(--md-ripple-pressed-color, currentColor)",
            opacity: flatPressed
              ? "var(--md-ripple-pressed-opacity, 0.12)"
              : 0,
            transition: `opacity ${FLAT_PRESS_FADE_MS}ms linear`,
          }}
        />
      ) : null}
    </div>
  );
};

export default MaterialRipple;
