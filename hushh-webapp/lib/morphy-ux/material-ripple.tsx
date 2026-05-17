
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
 */

import React, { useEffect, useRef, useState } from "react";
import { type ColorVariant, type ComponentEffect } from "./types";

// ============================================================================
// TYPES - MdRipple interface is now in global.d.ts
// ============================================================================

interface MdRipple extends HTMLElement {
  disabled: boolean;
}

// ============================================================================
// COLOR MAPPING - Morphy Variants to Material 3 Tokens
// ============================================================================

export const getMaterialRippleColors = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill",
  isDarkMode: boolean = false
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
        hoverColor: "var(--morphy-primary-start)",
        pressedColor: "var(--morphy-primary-start)",
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
}

export const MaterialRipple = ({
  variant = "gradient",
  effect = "fill",
  disabled = false,
  className = "",
}: MaterialRippleProps) => {
  const rippleRef = useRef<MdRipple>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRippleReady, setIsRippleReady] = useState(false);

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
          error
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
    if (!isRippleReady || !containerRef.current || rippleRef.current) return;

    const rippleElement = document.createElement("md-ripple") as MdRipple;
    rippleElement.className = "morphy-md-ripple";
    rippleElement.disabled = disabled;
    containerRef.current.appendChild(rippleElement);
    rippleRef.current = rippleElement;

    return () => {
      if (rippleRef.current === rippleElement) {
        rippleRef.current = null;
      }
      rippleElement.remove();
    };
  }, [disabled, isRippleReady]);

  useEffect(() => {
    if (rippleRef.current) {
      rippleRef.current.disabled = disabled;
    }
  }, [disabled]);

  useEffect(() => {
    // Check for dark mode
    const isDarkMode = document.documentElement.classList.contains("dark");

    // Get colors based on variant and effect
    const colors = getMaterialRippleColors(variant, effect, isDarkMode);

    // Apply Material 3 tokens via CSS custom properties
    if (containerRef.current) {
      containerRef.current.style.setProperty(
        "--md-ripple-hover-color",
        colors.hoverColor
      );
      containerRef.current.style.setProperty(
        "--md-ripple-pressed-color",
        colors.pressedColor
      );
      containerRef.current.style.setProperty(
        "--md-ripple-hover-opacity",
        String(colors.hoverOpacity)
      );
      containerRef.current.style.setProperty(
        "--md-ripple-pressed-opacity",
        String(colors.pressedOpacity)
      );
    }
  }, [variant, effect]);

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
              colors.hoverColor
            );
            containerRef.current.style.setProperty(
              "--md-ripple-pressed-color",
              colors.pressedColor
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
      className={`morphy-ripple-host absolute inset-0 isolate overflow-hidden ${className}`}
      // Let the ripple host own the clip boundary for rounded actionables.
      style={{ borderRadius: "inherit", contain: "paint" }}
    />
  );
};

export default MaterialRipple;
