"use client";

import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface HoldToConfirmProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  onConfirm: () => void;
  holdDurationMs?: number;
  label?: string;
  destructive?: boolean;
}

/**
 * Accessible Hold-to-Confirm Button
 * Prevents accidental destructive actions (e.g., Revoking Consent, Deleting Keys) 
 * without requiring annoying confirmation modals.
 * Supports touch, mouse, and keyboard (holding Space/Enter).
 */
export function HoldToConfirm({
  onConfirm,
  holdDurationMs = 1500,
  label = "Hold to confirm",
  destructive = true,
  className,
  ...props
}: HoldToConfirmProps) {
  const [progress, setProgress] = React.useState(0);
  const [isHolding, setIsHolding] = React.useState(false);
  const intervalRef = React.useRef<NodeJS.Timeout | null>(null);

  const startHold = React.useCallback(() => {
    setIsHolding(true);
    const updateInterval = 50;
    const increment = (updateInterval / holdDurationMs) * 100;

    intervalRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev + increment >= 100) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setIsHolding(false);
          onConfirm();
          return 100;
        }
        return prev + increment;
      });
    }, updateInterval);
  }, [holdDurationMs, onConfirm]);

  const stopHold = React.useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsHolding(false);
    setProgress(0);
  }, []);

  // Cleanup on unmount to prevent memory leaks
  React.useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Keyboard accessibility support (Space or Enter)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isHolding && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      startHold();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      stopHold();
    }
  };

  return (
    <button
      type="button"
      onPointerDown={startHold}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className={cn(
        "relative overflow-hidden rounded-md px-4 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "select-none touch-none", // Prevent native mobile text-selection or zooming during long-press
        destructive 
          ? "bg-destructive/10 text-destructive hover:bg-destructive/20" 
          : "bg-muted text-foreground hover:bg-muted/80",
        className
      )}
      aria-label={`${label}. Hold for ${holdDurationMs / 1000} seconds to execute.`}
      {...props}
    >
      {/* Progress Fill Background */}
      <span
        className={cn(
          "absolute inset-0 left-0 top-0 h-full w-full origin-left ease-linear",
          destructive ? "bg-destructive/20" : "bg-primary/20"
        )}
        style={{
          transform: `scaleX(${progress / 100})`,
          transitionProperty: "transform",
          transitionDuration: isHolding ? "50ms" : "300ms", // Instant updates while holding, smooth decay on release
        }}
        aria-hidden="true"
      />

      {/* Foreground Text */}
      <span className="relative z-10 flex items-center justify-center gap-2">
        {label}
      </span>
      
      {/* A11y Live Region for Screen Readers */}
      <span className="sr-only" aria-live="polite">
        {progress === 100 ? "Action confirmed." : isHolding ? "Holding to confirm..." : ""}
      </span>
    </button>
  );
}