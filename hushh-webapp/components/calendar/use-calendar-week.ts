"use client";

import { useEffect, useLayoutEffect, useState } from "react";

import { buildCalendarWeek, msUntilNextLocalMidnight, type CalendarWeek } from "./calendar-week";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The week containing today, kept current while the screen stays mounted.
 *
 * Returns `null` on the server and before the first client layout pass, so
 * the date is only ever read from the device clock. A refresh is scheduled
 * for the next local midnight and the clock is re-read whenever the page
 * becomes visible, regains focus or returns from the back/forward cache, so a
 * sleeping or backgrounded device shows today's date rather than a counted-up
 * one. State only changes when the local day does.
 */
export function useCalendarWeek(): CalendarWeek | null {
  const [week, setWeek] = useState<CalendarWeek | null>(null);

  useIsomorphicLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = () => {
      const now = new Date();
      const next = buildCalendarWeek(now);
      setWeek((current) => (current?.dayKey === next.dayKey ? current : next));
      clearTimeout(timer);
      timer = setTimeout(sync, msUntilNextLocalMidnight(now));
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") sync();
    };

    sync();
    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return week;
}
