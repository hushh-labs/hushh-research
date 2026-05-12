"use client";

import { useCallback, useEffect, useRef } from "react";

type IdleRefreshOptions = {
  idleMs?: number;
  enabled?: boolean;
};

export function useIdleRefresh(
  onRefresh: () => void | Promise<void>,
  { idleMs = 60000, enabled = true }: IdleRefreshOptions = {}
) {
  const timeoutRef = useRef<number | null>(null);

  const resetIdleTimer = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      void onRefresh();
    }, idleMs);
  }, [idleMs, onRefresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void onRefresh();
        resetIdleTimer();
      }
    };

    const handleActivity = () => {
      resetIdleTimer();
    };

    resetIdleTimer();

    window.addEventListener("focus", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("touchstart", handleActivity);

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      window.removeEventListener("focus", handleVisibilityChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
    };
  }, [enabled, onRefresh, resetIdleTimer]);
}