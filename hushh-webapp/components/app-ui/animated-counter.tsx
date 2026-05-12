"use client";

import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface AnimatedCounterProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  durationMs?: number;
  format?: (val: number) => string;
}

/**
 * Accessible Animated Counter
 * Smoothly counts up to a target number using performant easing.
 * Hides intermediate animation frames from screen readers and respects OS reduced-motion settings.
 */
export function AnimatedCounter({
  value,
  durationMs = 1200,
  format = (v) => v.toLocaleString(),
  className,
  ...props
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = React.useState(0);

  React.useEffect(() => {
    // A11y & UX: Immediately jump to the final value if the user prefers reduced motion
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplayValue(value);
      return;
    }

    let startTime: number;
    let animationFrame: number;
    const startValue = displayValue;

    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / durationMs, 1);

      // Easing function (easeOutExpo) for a natural slowdown at the end
      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = startValue + (value - startValue) * easeProgress;

      setDisplayValue(Math.round(current));

      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        setDisplayValue(value);
      }
    };

    animationFrame = requestAnimationFrame(animate);

    // Cleanup to prevent memory leaks if component unmounts mid-animation
    return () => cancelAnimationFrame(animationFrame);
  }, [value, durationMs, displayValue]); // Re-run if target value changes

  return (
    <span className={cn("tabular-nums", className)} {...props}>
      {/* Visual animation (hidden from screen readers to prevent noise spam) */}
      <span aria-hidden="true">{format(displayValue)}</span>
      
      {/* Actual final value announced cleanly to screen readers */}
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}