"use client";

import { useEffect, useState } from "react";

/** Keeps payment deadlines current without coupling Feed's data hook to a timer. */
export function useFeedPaymentClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!enabled || typeof window === "undefined") return;

    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled]);

  return now;
}
