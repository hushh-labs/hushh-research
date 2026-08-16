"use client";

import { useEffect, useState } from "react";

/**
 * A ticking clock for the live-share countdown that stays honest across an iOS
 * app suspend.
 *
 * Two things make this more than `setInterval(setNow, 1000)`:
 *
 * 1. A backgrounded WKWebView (and a hidden browser tab) throttles or stops
 *    timers. Coming back to the app would otherwise show whatever value the
 *    clock froze at, which is exactly the "my share time didn't move" symptom
 *    this is here to fix. Every resume signal re-reads `Date.now()` immediately,
 *    so the first frame after resume is already correct.
 * 2. While hidden, the interval is torn down instead of firing into a screen
 *    nobody is looking at.
 *
 * Scope it to the smallest subtree that shows a moving number — this re-renders
 * its consumer on every tick.
 */
export function useShareClock(active: boolean, intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    let timer = 0;
    const sync = () => setNowMs(Date.now());

    const stop = () => {
      if (timer) window.clearInterval(timer);
      timer = 0;
    };
    const start = () => {
      stop();
      sync();
      timer = window.setInterval(sync, Math.max(250, intervalMs));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    // `focus` covers a web tab returning; `pageshow` covers the back/forward
    // cache and the native shell restoring a suspended web view.
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, [active, intervalMs]);

  return nowMs;
}
