/**
 * StreamingCursor Component
 *
 * A blinking cursor indicator for streaming text, similar to ChatGPT/Perplexity.
 * Uses CSS step-end animation for crisp on/off blinking when idle,
 * and solid display when actively streaming.
 *
 * @example
 * <StreamingCursor isStreaming={true} />
 * <StreamingCursor isStreaming={false} color="accent" size="lg" />
 */

"use client";

import { cn } from "./cn";

export interface StreamingCursorProps {
  /** Whether text is actively streaming (solid) or idle (blinking) */
  isStreaming: boolean;
  /** Cursor color variant */
  color?: "primary" | "muted" | "accent" | "success" | "error";
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Additional CSS classes */
  className?: string;
}

const sizeClasses = {
  sm: "w-[0.4em] h-[0.9em]",
  md: "w-[0.5em] h-[1em]",
  lg: "w-[0.6em] h-[1.1em]",
} as const;

const colorClasses = {
  primary: "bg-[var(--morphy-primary-start)]",
  muted: "bg-muted-foreground",
  accent: "bg-[#fbbf24]",
  success: "bg-emerald-500",
  error: "bg-red-500",
} as const;

export function StreamingCursor({
  isStreaming,
  color = "primary",
  size = "md",
  className,
}: StreamingCursorProps) {
  return (
    <span
      className={cn(
        "inline-block ml-0.5 rounded-[1px] align-middle",
        sizeClasses[size],
        colorClasses[color],
        // Solid when streaming, blink when idle
        isStreaming ? "opacity-100" : "animate-cursor-blink",
        className
      )}
      aria-hidden="true"
      role="presentation"
    />
  );
}
