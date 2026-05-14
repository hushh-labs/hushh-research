"use client";

import { cn } from "@/lib/utils";

type RouteHydrationOverlayProps = {
  label?: string;
  active?: boolean;
  className?: string;
};

export function RouteHydrationOverlay({
  label = "Preparing your experience...",
  active = true,
  className,
}: RouteHydrationOverlayProps) {
  if (!active) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3",
        className
      )}
    >
      <div className="w-full max-w-sm rounded-full border border-border/60 bg-background/90 px-3 py-2 shadow-sm backdrop-blur">
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-foreground/70" />
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}