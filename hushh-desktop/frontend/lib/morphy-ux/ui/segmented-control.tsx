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
 * - Accessible keyboard navigation
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
}

interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  variant?: "compact" | "expanding";
  size?: "sm" | "default" | "lg";
  className?: string;
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
}: SegmentedControlProps) {
  const isExpanding = variant === "expanding";
  
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

  return (
    <div
      role="radiogroup"
      className={cn(
        "inline-flex items-center rounded-lg",
        "bg-muted/80 backdrop-blur-xl",
        "border border-white/10 dark:border-white/5",
        "shadow-lg ring-1 ring-black/5",
        config.container,
        className
      )}
    >
      {options.map((option) => {
        const isActive = value === option.value;
        const Icon = option.icon;
        
        return (
          <button
            type="button"
            key={option.value}
            role="radio"
            aria-checked={isActive}
            onClick={() => onValueChange(option.value)}
            className={cn(
              // Base styles
              "relative flex items-center justify-center gap-2 rounded-md",
              "transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)]",
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
                  "transition-transform duration-500 ease-[cubic-bezier(0.25,1,0.5,1)]",
                  isActive && "scale-105"
                )}
              />
            )}
            
            {/* Label - always visible in compact, animated in expanding */}
            {isExpanding ? (
              <div
                className={cn(
                  "overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] flex items-center",
                  isActive
                    ? "w-auto max-w-[100px] opacity-100 ml-0.5"
                    : "w-0 max-w-0 opacity-0"
                )}
              >
                <span className="font-medium whitespace-nowrap">
                  {option.label}
                </span>
              </div>
            ) : (
              <span className="font-medium whitespace-nowrap">
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
