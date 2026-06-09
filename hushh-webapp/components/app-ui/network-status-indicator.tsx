"use client";

import React, { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNetworkStatus } from "@/lib/hooks/use-network-status";

/**
 * A global floating indicator that notifies the user when they lose internet connection,
 * and briefly shows a success message when the connection is restored.
 */
export function NetworkStatusIndicator() {
  const { isOnline, isOffline, wasOffline } = useNetworkStatus();
  const [showRestored, setShowRestored] = useState(false);

  // When connection is restored after being offline, show the "Back online" pill briefly.
  useEffect(() => {
    if (isOnline && wasOffline) {
      setShowRestored(true);
      const timer = setTimeout(() => {
        setShowRestored(false);
      }, 3500); // Hide after 3.5 seconds
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOnline, wasOffline]);

  const isVisible = isOffline || showRestored;

  return (
    <div
      className={cn(
        "fixed bottom-6 left-1/2 z-[9999] flex -translate-x-1/2 transform items-center justify-center transition-all duration-500 ease-in-out",
        isVisible
          ? "translate-y-0 opacity-100 scale-100"
          : "translate-y-8 opacity-0 scale-95 pointer-events-none"
      )}
      aria-hidden={!isVisible}
    >
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-full px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md border transition-colors duration-300",
          isOffline
            ? "border-destructive/40 bg-destructive/90 text-destructive-foreground dark:bg-destructive/80"
            : "border-green-500/40 bg-green-500/90 text-white dark:bg-green-600/80"
        )}
        role="alert"
        aria-live="polite"
      >
        {isOffline ? (
          <>
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>You are offline. Retrying connection...</span>
          </>
        ) : (
          <>
            <Wifi className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Connection restored!</span>
          </>
        )}
      </div>
    </div>
  );
}
