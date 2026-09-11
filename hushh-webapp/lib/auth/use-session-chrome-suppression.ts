"use client";

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

const activeSuppressionTokens = new Set<symbol>();
const subscribers = new Set<() => void>();

function syncSessionChromeSuppression(): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(
    "data-session-check-active",
    activeSuppressionTokens.size > 0,
  );
}

function notify(): void {
  syncSessionChromeSuppression();
  for (const listener of subscribers) listener();
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
    notify();
    return () => {
      activeSuppressionTokens.delete(token);
      notify();
    };
  }, [active]);
}

/**
 * Is the persistent chrome suppressed right now?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A ROUTE CHECK
 * Suppression hid the chrome with a DOM attribute while every component beneath
 * it stayed mounted and every fetch still went out. So a brand-new person waiting
 * on the setup gate was also paying for a nav badge, a second badge, an avatar
 * image, and a persona read -- four of the four connections in the pool, for
 * chrome nobody could see. Hiding was doing no work; only stopping the fetch does.
 *
 * The first attempt at this gated on `isOneSetupSurfaceRoute(pathname)` and
 * MEASURED NO EFFECT, for a reason worth keeping written down: during the
 * post-login redirect the app renders the setup hub while `location.pathname` is
 * still `/login`. The rendered surface and the URL disagree for exactly the
 * window that matters, so any route-derived gate is blind precisely when the
 * contention happens. Suppression state is not: the guard sets it because it is
 * deciding, which is the same moment the pool is scarce.
 *
 * Module-level rather than context on purpose. Every consumer -- Navbar, the top
 * bar, the persona provider -- sits ABOVE the guard in the tree, so no React
 * context could ever reach them.
 */
export function useSessionChromeSuppressed(): boolean {
  const subscribe = useCallback((listener: () => void) => {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => activeSuppressionTokens.size > 0,
    // Server render: never suppressed, so SSR markup matches a first client paint
    // with no guard mounted yet.
    () => false,
  );
}

/** Test hook: drop any suppression a previous test left behind. */
export function __resetSessionChromeSuppressionForTests(): void {
  activeSuppressionTokens.clear();
  notify();
}
