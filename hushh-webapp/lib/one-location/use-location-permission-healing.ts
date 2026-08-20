"use client";

import { useEffect } from "react";

import { OneLocationService } from "@/lib/one-location/service";

/**
 * Notice the moment someone un-blocks location, without making them tell us.
 *
 * The recovery instructions send a person out of the page and into browser
 * settings. Every second they spend back here wondering whether it worked is a
 * second the fix looks broken, and "now reload the page" is one instruction
 * more than they should have to carry.
 *
 * Two signals, because no single one covers every browser:
 *
 * 1. **`PermissionStatus.onchange`** — the exact event. Chromium fires it the
 *    instant the site's Location switch flips, even while the tab sits in the
 *    background, so the page heals before the person has finished looking back
 *    at it. Safari does not implement `permissions.query('geolocation')` at all
 *    and rejects, which is why it cannot be the only signal.
 *
 * 2. **Returning to the tab** — `visibilitychange` and `focus`. Coarser, but it
 *    works everywhere, and it is exactly when someone comes back from settings.
 *
 * Both paths only ever *read* permission. Neither attempts a capture, so
 * nothing here can trigger a prompt, a toast, or a GPS read behind the person's
 * back — this hook observes, and hands the decision to act to its caller.
 */
export function useLocationPermissionHealing(params: {
  /** Only watch while the person is actually stuck. */
  enabled: boolean;
  /** Called once, when permission is observed to have become usable. */
  onGranted: () => void;
}): void {
  const { enabled, onGranted } = params;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    let settled = false;
    let status: PermissionStatus | null = null;

    // Fire at most once. A second call would re-enter the caller's capture
    // while the first is still running, which on iOS spends a prompt and on
    // web doubles the GPS work for one recovery.
    const grant = () => {
      if (cancelled || settled) return;
      settled = true;
      onGranted();
    };

    const check = async () => {
      if (cancelled || settled) return;
      try {
        const permission = await OneLocationService.getPermissionState();
        if (permission?.state === "granted") grant();
      } catch {
        // Unreadable permission is not a failure to recover from. The person
        // can still press the button, and the visibility path will try again.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    void (async () => {
      try {
        const query = navigator.permissions?.query;
        if (!query) return;
        const next = await navigator.permissions.query({
          name: "geolocation" as PermissionName,
        });
        if (cancelled) return;
        status = next;
        // Already fixed before this mounted — for instance the person un-blocked
        // it, then navigated back rather than switching tabs.
        if (next.state === "granted") {
          grant();
          return;
        }
        next.onchange = () => {
          if (next.state === "granted") grant();
        };
      } catch {
        // WebKit rejects this query outright. The visibility listeners above
        // are the whole recovery path there, and they are already attached.
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      if (status) status.onchange = null;
    };
  }, [enabled, onGranted]);
}
