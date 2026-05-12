"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

/**
 * Reactive Network Status Observer
 * Automatically detects when the user loses internet connection and displays
 * an accessible, non-blocking toast warning at the bottom of the screen.
 */
export function NetworkStatus() {
  const [isOffline, setIsOffline] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    // Set initial state
    setIsOffline(!navigator.onLine);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "fixed bottom-6 left-1/2 z-[100] flex w-max -translate-x-1/2 items-center gap-2",
        "rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-lg",
        "animate-in slide-in-from-bottom-8 fade-in duration-300"
      )}
    >
      <WifiOff className="size-4" aria-hidden="true" />
      <span>You are currently offline.</span>
    </div>
  );
}