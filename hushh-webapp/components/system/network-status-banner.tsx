"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { cn } from "@/lib/utils";

export function NetworkStatusBanner() {
  const { offline } = useNetworkStatus();
  const [show, setShow] = React.useState(false);

  // Debounce the visibility: only show if offline for > 500ms
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (offline) {
      timer = setTimeout(() => setShow(true), 500);
    } else {
      setShow(false);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [offline]);

  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn(
        "fixed inset-x-0 top-0 z-[9999] flex justify-center border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 backdrop-blur dark:text-amber-300",
        "animate-in slide-in-from-top duration-300"
      )}
    >
      <div className="flex items-center gap-2">
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">You are currently offline.</span>
      </div>
    </div>
  );
}