// lib/morphy-ux/ui/segmented-control.tsx

/**
 * Morphy-UX Segmented Control
 *
 * A unified component for single-value selection:
 * - Compact: Equal-width segments (for period selectors, filters)
 * - Expanding: Active segment expands with label (for theme toggle, navigation)
 * - Sliding: Equal-width icon choices with one retained selection thumb
 *
 * Features:
 * - Material 3 Expressive ripple effects
 * - Glassmorphism styling
 * - Dark mode support
 * - Accessible keyboard navigation: one tab stop, arrow keys, Home/End
 *
 * Bounded radio selections share semantics; route tabs and their continuous
 * swipe indicators retain their own pager. Sliding preserves the existing
 * Appearance geometry, rather than introducing a route-local selector.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { appHaptic } from "@/lib/capacitor/app-haptics";

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
  variant?: "compact" | "expanding" | "sliding";
  size?: "sm" | "default" | "lg";
  className?: string;
  disabled?: boolean;
  /** Opt out when the accepted navigation owner emits its own cue. */
  hapticFeedback?: boolean;
  /** Bounded choices can keep their authored two-column phone layout. */
  mobileColumns?: 2;
  /**
   * The group's name, matching `SegmentedPill`'s prop of the same name.
   *
   * Deliberately NOT defaulted: an unnamed radiogroup is easy to catch in
   * review, while a generic default ("Segmented selector") is meaningless and
   * invisible. Callers should pass what the group actually chooses between.
   */
  ariaLabel?: string;
  /**
   * Classes for every segment's icon and visible label, so a caller can trade
   * one for the other at a breakpoint (for example an icon-only control on a
   * phone header: `iconClassName="sm:hidden"` + `labelClassName="max-sm:hidden"`).
   * Only do that when every option carries both an `icon` and an
   * `accessibleLabel`: a segment with neither visible text nor a spoken name
   * is unnamed.
   */
  iconClassName?: string;
  labelClassName?: string;
  /** Authored selected-control focus return for a native presentation adapter. */
  selectedButtonRef?: React.RefObject<HTMLButtonElement | null>;
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
  disabled = false,
  hapticFeedback = true,
  mobileColumns,
  ariaLabel,
  iconClassName,
  labelClassName,
  selectedButtonRef,
}: SegmentedControlProps) {
  const isExpanding = variant === "expanding";
  const isSliding = variant === "sliding";
  const buttonsRef = React.useRef<Array<HTMLButtonElement | null>>([]);

  // Size configurations
  const sizeConfig = {
    sm: {
      container: "h-8 p-[3px] rounded-full",
      segment: "px-3 py-1 text-xs",
      icon: "w-3.5 h-3.5",
      expandedWidth: "min-w-[70px]",
      collapsedWidth: "min-w-[32px]",
    },
    default: {
      container: "h-9 p-[3px] rounded-full",
      segment: "px-3.5 py-1.5 text-sm",
      icon: "w-4 h-4",
      expandedWidth: "min-w-[90px]",
      collapsedWidth: "min-w-[36px]",
    },
    lg: {
      container: "h-11 p-1 rounded-full",
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
    if (!option || disabled) return;
    if (option.value !== value) {
      onValueChange(option.value);
      if (hapticFeedback) appHaptic("selection");
    }
    buttonsRef.current[index]?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    // Browser and OS chords keep their meaning.
    if (disabled || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
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
      aria-disabled={disabled || undefined}
      style={isSliding ? { minWidth: options.length * 44 + 6 } : undefined}
      className={cn(
        "relative inline-flex items-center rounded-full",
        isSliding
          ? "h-11 px-[3px]"
          : "bg-black/[0.04] dark:bg-white/[0.06] backdrop-blur-md border border-black/[0.06] dark:border-white/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]",
        !isSliding && config.container,
        mobileColumns === 2 && !isSliding && "grid h-auto grid-cols-2 sm:inline-flex",
        disabled && "opacity-50",
        className
      )}
    >
      {isSliding ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 inset-y-1 rounded-full bg-black/[0.05] dark:bg-white/[0.07]" /> : null}
      {isSliding && activeIndex >= 0 ? <span aria-hidden="true" data-slot="segmented-selection"
        className="pointer-events-none absolute inset-y-[7px] left-[3px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-neutral-800 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-transform duration-150 ease-out motion-reduce:transition-none"
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${activeIndex * 100}%)` }} /> : null}
      {options.map((option, index) => {
        const isActive = value === option.value;
        const Icon = option.icon;

        return (
          <button
            type="button"
            key={option.value}
            ref={(node) => {
              buttonsRef.current[index] = node;
              if (index === focusIndex && selectedButtonRef) selectedButtonRef.current = node;
            }}
            role="radio"
            aria-checked={isActive}
            aria-label={option.accessibleLabel}
            disabled={disabled}
            // Roving tabindex: a radio group is ONE tab stop, and the arrows
            // move within it.
            tabIndex={!disabled && index === focusIndex ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => moveTo(index)}
            className={cn(
              // Base styles
              "relative flex items-center justify-center rounded-full select-none",
              isSliding ? "gap-1" : "gap-1.5",
              // A press is flat: colour and the ripple, never a scale. The
              // duration comes off the motion scale (a 500ms transition once
              // left the segment sagging under the thumb).
              "transition-[color,background-color,box-shadow] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "overflow-hidden font-normal tracking-tight",
              isSliding ? "z-10 h-full min-w-0 px-0.5" : config.segment,
              mobileColumns === 2 && !isSliding && "min-h-11",

              // Active state
              isActive && (isSliding ? "text-slate-950 dark:text-white" : [
                "bg-white text-neutral-900 font-semibold shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]",
                "dark:bg-white/[0.16] dark:text-white dark:shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
              ]),

              // Inactive state
              !isActive && [
                isSliding ? "text-slate-500 dark:text-zinc-400" : "text-muted-foreground/75",
                "hover:text-foreground",
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
                  isActive && !isSliding && "scale-105",
                  iconClassName,
                )}
                aria-hidden
              />
            )}

            {/* Label - always visible in compact, animated in expanding */}
            {isExpanding ? (
              <div
                className={cn(
                  "overflow-hidden transition-[opacity,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] flex items-center",
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
              <span className={cn("whitespace-nowrap", labelClassName)}>
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
