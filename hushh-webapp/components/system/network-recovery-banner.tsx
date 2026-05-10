"use client";

import { WifiOff } from "lucide-react";

import { useNetworkStatus } from "@/hooks/use-network-status";

export function NetworkRecoveryBanner() {
  const { isOnline } = useNetworkStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 shadow-[var(--app-card-shadow-feature)] backdrop-blur md:left-auto md:right-6 md:w-[420px]"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-amber-500/15 p-2">
          <WifiOff className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>

        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            You&apos;re offline
          </p>

          <p className="text-sm leading-6 text-muted-foreground">
            Some actions may not sync until your connection is restored. We&apos;ll automatically resume when you&apos;re back online.
          </p>
        </div>
      </div>
    </div>
  );
}