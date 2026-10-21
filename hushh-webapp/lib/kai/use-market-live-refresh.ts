"use client";

import { useEffect, useId, useRef } from "react";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";

export const MARKET_REFRESH_INTERVAL_MS = 120_000;

const easternClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Cadence only. Provider metadata remains the authority for displayed status. */
export function usMarketRefreshSession(now = Date.now()): string | null {
  const parts = Object.fromEntries(
    easternClock.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === "Sat" || parts.weekday === "Sun" || minute < 570 || minute >= 960) {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Keep the shared Market/Stocks resource fresh without polling a hidden phone. */
export function useMarketLiveRefresh(
  refresh: (force: boolean) => Promise<unknown>,
  ownerId: string | null,
): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const taskId = `market-live:${useId()}`;

  useEffect(() => {
    if (!ownerId) return;
    let active = true;
    let inFlight = false;
    let lastSession: string | null = null;
    let lastAttemptSlot: number | null = null;

    const run = async (allowClosed = false): Promise<void> => {
      if (!active || inFlight || document.visibilityState !== "visible" || !navigator.onLine) return;
      const session = usMarketRefreshSession();
      if (!session && !allowClosed) return;
      const slot = Math.floor(Date.now() / MARKET_REFRESH_INTERVAL_MS);
      if (lastSession === session && lastAttemptSlot === slot) return;
      // Count attempts, including failures, so resume signals cannot cause a retry storm.
      lastSession = session;
      lastAttemptSlot = slot;
      inFlight = true;
      try {
        await refreshRef.current(session !== null);
      } catch {
        // The resource retains its last snapshot and owns error presentation.
      } finally {
        inFlight = false;
        // An opening crossed by an outstanding pre-open read needs a forced read too.
        const currentSession = usMarketRefreshSession();
        if (active && currentSession && currentSession !== lastSession) void run();
      }
    };

    const resume = () => { void run(true); };
    // Keep the session check registered before opening. 09:30 ET aligns with
    // this shared two-minute clock in both daylight-saving and standard time.
    // The local in-flight guard also covers focus/online/visibility events.
    const unregister = registerPeriodicTask({
      id: taskId,
      intervalMs: MARKET_REFRESH_INTERVAL_MS,
      run: () => { void run(); },
    });
    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      active = false;
      unregister();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [ownerId, taskId]);
}
