"use client";

import { useLayoutEffect, useRef } from "react";

const activeSuppressionTokens = new Set<symbol>();

function syncSessionChromeSuppression(): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(
    "data-session-check-active",
    activeSuppressionTokens.size > 0,
  );
}

/**
 * Hides persistent navigation chrome before paint while an authenticated route
 * verifies session state. Guards live below the shared shell, so this closes
 * the otherwise-visible frame where a newly rendered session loader can sit
 * above chrome from the previous authenticated surface.
 */
export function useSessionChromeSuppression(active: boolean): void {
  const tokenRef = useRef<symbol | null>(null);
  if (!tokenRef.current) tokenRef.current = Symbol("session-chrome");

  useLayoutEffect(() => {
    const token = tokenRef.current;
    if (!active || !token) return;

    activeSuppressionTokens.add(token);
    syncSessionChromeSuppression();
    return () => {
      activeSuppressionTokens.delete(token);
      syncSessionChromeSuppression();
    };
  }, [active]);
}
