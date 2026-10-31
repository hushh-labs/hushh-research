"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JourneyTrace } from "@/lib/observability/journey-trace";

/** "Checking…" lasts exactly as long as the caller's retry; a void retry settles at once.
 * The AuthProvider still coalesces retries, so this is feedback, not the only guard. */
export function usePendingRetry(onRetry: () => void | Promise<unknown>, trace?: JourneyTrace): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retry = useCallback(() => {
    setPending(true);
    const started = performance.now();
    trace?.("refresh_requested");
    const settle = (outcome: "settled" | "failed") => () => {
      trace?.(`refresh_${outcome}`, { duration_ms: Math.round(performance.now() - started) });
      if (mounted.current) setPending(false);
    };
    // A synchronous throw settles too; validation itself runs under its own deadline.
    void new Promise<unknown>(resolve => resolve(onRetry())).then(settle("settled"), settle("failed"));
  }, [onRetry, trace]);
  return [pending, retry];
}
