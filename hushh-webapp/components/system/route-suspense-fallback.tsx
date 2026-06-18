"use client";

import * as React from "react";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { cn } from "@/lib/utils";

type RouteSuspenseFallbackProps = {
  label?: string;
  isOverlay?: boolean; // New: Full-screen overlay support
  delayWarningMs?: number; // New: Show warning if loading > X ms
};

export function RouteSuspenseFallback({
  label = "Loading page…",
  isOverlay = false,
  delayWarningMs = 5000,
}: RouteSuspenseFallbackProps) {
  const [showSlowLoadWarning, setShowSlowLoadWarning] = React.useState(false);

  // Trigger warning if loading persists
  React.useEffect(() => {
    const timer = setTimeout(() => setShowSlowLoadWarning(true), delayWarningMs);
    return () => clearTimeout(timer);
  }, [delayWarningMs]);

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center px-6",
        isOverlay ? "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" : "min-h-[320px] py-12"
      )}
    >
      <div className="flex flex-col items-center gap-4">
        <HushhLoader variant="inline" label={label} />

        {/* Slow network feedback */}
        {showSlowLoadWarning && (
          <p className="animate-in fade-in slide-in-from-top-2 text-xs text-muted-foreground mt-2">
            This is taking longer than expected...
          </p>
        )}
      </div>
    </div>
  );
}