"use client";

import { useCallback, useEffect, useState } from "react";

export function useRetryCooldown(durationMs = 5000) {
  const [retryAvailableAt, setRetryAvailableAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);

  const startCooldown = useCallback(() => {
    const nextRetryTime = Date.now() + durationMs;

    setRetryAvailableAt(nextRetryTime);
    setRemainingMs(durationMs);
  }, [durationMs]);

  const resetCooldown = useCallback(() => {
    setRetryAvailableAt(null);
    setRemainingMs(0);
  }, []);

  useEffect(() => {
    if (!retryAvailableAt) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const nextRemainingMs = Math.max(retryAvailableAt - Date.now(), 0);

      setRemainingMs(nextRemainingMs);

      if (nextRemainingMs <= 0) {
        setRetryAvailableAt(null);
      }
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [retryAvailableAt]);

  return {
    coolingDown: remainingMs > 0,
    remainingMs,
    startCooldown,
    resetCooldown,
  };
}