// lib/morphy-ux/ui/segmented-control.tsx

/**
 * Morphy-UX Segmented Control
 *
 * A unified component for single-value selection with two variants:
 * - Compact: Equal-width segments (for period selectors, filters)
 * - Expanding: Active segment expands with label (for theme toggle, navigation)
 *
 * Features:
 * - Material 3 Expressive ripple effects
 * - Glassmorphism styling
 * - Dark mode support
 * - Accessible keyboard navigation: one tab stop, arrow keys, Home/End
 *
 * There is no sliding thumb here. The active segment is a per-button
 * background that cross-fades. `segmented-pill.tsx` is the primitive that
 * already ships a translateX indicator with its own theme hooks and
 * reduced-motion guard; a second implementation of it would be a duplicate
 * path, so callers that want the slide should reach for that one instead.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

// =============================================================================
// TYPES
// =============================================================================

export interface SegmentOption {
  value: string;
  label: string;
  icon?: React.ElementType;
  /**
   * What a screen reader hears instead of `label`.
   *
   * The visible label is squeezed to fit a header; the spoken one does not
   * have to be. On a control that chooses between two different agents, "One"
   * and "Puppy" alone do not say what is being chosen.
   */
  accessibleLabel?: string;
}

interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  variant?: "compact" | "expanding";
  size?: "sm" | "default" | "lg";
  className?: string;
  /**
   * The group's name, matching `SegmentedPill`'s prop of the same name.
   *
   * Deliberately NOT defaulted: an unnamed radiogroup is easy to catch in
   * review, while a generic default ("Segmented selector") is meaningless and
   * invisible. Callers should pass what the group actually chooses between.
   */
  ariaLabel?: string;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function SegmentedControl({
  value,
  onValueChange,
  options,
  variant = "compact",
  size = "default",
  className,
  ariaLabel,
}: SegmentedControlProps) {
  const isExpanding = variant === "expanding";
  const buttonsRef = React.useRef<Array<HTMLButtonElement | null>>([]);

  // Size configurations
  const sizeConfig = {
    sm: {
      container: "h-8 p-0.5",
      segment: "px-2 py-1 text-xs",
      icon: "w-3.5 h-3.5",
      expandedWidth: "min-w-[70px]",
      collapsedWidth: "min-w-[32px]",
    },
    default: {
      container: "h-10 p-1",
      segment: "px-3 py-1.5 text-sm",
      icon: "w-4 h-4",
      expandedWidth: "min-w-[90px]",
      collapsedWidth: "min-w-[36px]",
    },
    lg: {
      container: "h-12 p-1",
      segment: "px-4 py-2 text-base",
      icon: "w-5 h-5",
      expandedWidth: "min-w-[110px]",
      collapsedWidth: "min-w-[44px]",
    },
  };

  const config = sizeConfig[size];

  const activeIndex = options.findIndex((option) => option.value === value);
  // A controlled value that matches no option (initial state, a stale
  // persisted choice) must not make every segment tabIndex -1 and drop the
  // whole control out of the tab order, which would be worse than the two
  // tab stops this replaces.
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;

  const moveTo = (index: number) => {
    const option = options[index];
    if (!option) return;
    onValueChange(option.value);
    buttonsRef.current[index]?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    // Browser and OS chords keep their meaning.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const last = options.length - 1;
    if (last < 0) return;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        // Without preventDefault the vertical arrows scroll the page under a
        // control that usually lives in a sticky header.
        event.preventDefault();
        moveTo(index === last ? 0 : index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveTo(index === 0 ? last : index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(last);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center rounded-lg",
        "bg-muted/80 backdrop-blur-xl",
        "border border-white/10 dark:border-white/5",
        "shadow-lg ring-1 ring-black/5",
        config.container,
        className
      )}
    >
      {options.map((option, index) => {
        const isActive = value === option.value;
        const Icon = option.icon;

        return (
          <button
            type="button"
            key={option.value}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            role="radio"
            aria-checked={isActive}
            aria-label={option.accessibleLabel}
            // Roving tabindex: a radio group is ONE tab stop, and the arrows
            // move within it.
            tabIndex={index === focusIndex ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => onValueChange(option.value)}
            className={cn(
              // Base styles
              "press-scale relative flex items-center justify-center gap-2 rounded-md",
              // `transform` stays in the list, and the duration comes off the
              // motion scale. `transition-all` at 500ms covered the transform
              // that `.press-scale` drives on :active, so the button sagged
              // for half a second under the thumb against a 120ms press token,
              // and 500ms is off the scale entirely.
              "transition-[color,background-color,box-shadow,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "overflow-hidden",
              config.segment,

              // Active state
              isActive && [
                "bg-background text-foreground shadow-sm",
                "ring-1 ring-black/5",
              ],

              // Inactive state
              !isActive && [
                "text-muted-foreground",
                "hover:text-foreground hover:bg-muted/50",
              ],

              // Width handling for expanding variant
              isExpanding && isActive && config.expandedWidth,
              isExpanding && !isActive && config.collapsedWidth,

              // Equal width for compact variant
              !isExpanding && "flex-1",
            )}
          >
            {/* Icon */}
            {Icon && (
              <Icon
                className={cn(
                  config.icon,
                  "transition-transform duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                  isActive && "scale-105"
                )}
              />
            )}

            {/* Label - always visible in compact, animated in expanding */}
            {isExpanding ? (
              <div
                className={cn(
                  "overflow-hidden transition-all duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] flex items-center",
                  isActive
                    ? "w-auto max-w-[100px] opacity-100 ml-0.5"
                    : "w-0 max-w-0 opacity-0"
                )}
              >
                <span className="whitespace-nowrap">
                  {option.label}
                </span>
              </div>
            ) : (
              <span className="whitespace-nowrap">
                {option.label}
              </span>
            )}

            {/* Material 3 Ripple */}
            <MaterialRipple variant="link" effect="glass" />
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
