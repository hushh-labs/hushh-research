"use client";

import { useLayoutEffect, useRef } from "react";

import { WifiOff } from "@/components/icons";

import { syncNativePresentationRegions } from "@/lib/capacitor/native-presentation-regions";
import { useNetworkStatus } from "@/hooks/use-network-status";

export function NetworkStatusBanner() {
  const { offline } = useNetworkStatus();

  const banner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = banner.current;
    if (!offline || !element) return;
    const root = document.documentElement;
    // Reserve the rendered height, including wrapped or enlarged text.
    const measure = () => {
      const height = `${Math.ceil(element.getBoundingClientRect().height)}px`;
      if (root.style.getPropertyValue("--network-status-height") !== height) {
        root.style.setProperty("--network-status-height", height);
        void syncNativePresentationRegions().catch(() => undefined);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--network-status-height");
      queueMicrotask(() => { void syncNativePresentationRegions().catch(() => undefined); });
    };
  }, [offline]);

  if (!offline) {
    return null;
  }

  return (
    <div
      ref={banner}
      data-network-status-banner=""
      role="status"
      aria-live="polite"
      className="network-status-banner fixed inset-x-0 z-[9999] pointer-events-none border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-700 backdrop-blur dark:text-amber-300"
    >
      <div className="flex items-center justify-center gap-2">
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>You are offline. Some data may be outdated until your connection returns.</span>
      </div>
    </div>
  );
}
