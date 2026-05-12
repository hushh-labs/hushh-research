import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export type LiveStatus = "live" | "connecting" | "stale" | "offline";

export interface LiveDataIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  status: LiveStatus;
  label?: string;
}

/**
 * Accessible Live Data Indicator
 * Provides visual and screen-reader feedback for streaming connections (SSE, WebSockets).
 * Implements motion-safe CSS pulses and strict aria-live regions.
 */
export function LiveDataIndicator({
  status,
  label,
  className,
  ...props
}: LiveDataIndicatorProps) {
  const statusConfig = {
    live: { color: "bg-emerald-500", text: "Live", ping: true },
    connecting: { color: "bg-amber-500", text: "Connecting...", ping: true },
    stale: { color: "bg-orange-500", text: "Stale data", ping: false },
    offline: { color: "bg-muted-foreground", text: "Offline", ping: false },
  };

  const config = statusConfig[status];
  const displayText = label || config.text;

  return (
    <div
      className={cn("inline-flex items-center gap-2", className)}
      {...props}
    >
      <div className="relative flex size-2.5 items-center justify-center">
        {/* The pulsating ring (disabled if user prefers reduced motion) */}
        {config.ping && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping",
              config.color
            )}
            aria-hidden="true"
          />
        )}
        {/* The solid inner dot */}
        <span
          className={cn("relative inline-flex size-2.5 rounded-full", config.color)}
          aria-hidden="true"
        />
      </div>
      
      {/* Visual Text (Hidden from screen readers to prevent double-reading) */}
      <span className="text-xs font-medium tracking-wide text-muted-foreground" aria-hidden="true">
        {displayText}
      </span>

      {/* A11y: Screen reader only live region */}
      <span className="sr-only" aria-live="polite" role="status">
        {`Connection status: ${displayText}`}
      </span>
    </div>
  );
}