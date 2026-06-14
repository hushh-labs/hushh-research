"use client";

import { WifiOff } from "lucide-react";

import { useNetworkStatus } from "@/hooks/use-network-status";

export function NetworkStatusBanner() {
  const { offline } = useNetworkStatus();

  if (!offline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[9999] border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-700 backdrop-blur dark:text-amber-300"
    >
      <div className="flex items-center justify-center gap-2">
        <WifiOff className="h-4 w-4" aria-hidden="true" />
        <span>You are offline. Some data may be outdated until your connection returns.</span>
      </div>
    </div>
  );
}