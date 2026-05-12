"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ResilientPollingOptions = {
  intervalMs?: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
};

type PollRunner = () => Promise<void> | void;

export function useResilientPolling({
  intervalMs = 30000,
  enabled = true,
  pauseWhenHidden = true,
}: ResilientPollingOptions = {}) {
  const runnerRef = useRef<PollRunner | null>(null);
  const [polling, setPolling] = useState(false);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  const registerPollRunner = useCallback((runner: PollRunner) => {
    runnerRef.current = runner;
  }, []);

  const runPoll = useCallback(async () => {
    if (!runnerRef.current) return;
    if (pauseWhenHidden && document.visibilityState === "hidden") return;

    setPolling(true);

    try {
      await runnerRef.current();
      setLastPolledAt(Date.now());
    } finally {
      setPolling(false);
    }
  }, [pauseWhenHidden]);

  useEffect(() => {
    if (!enabled) return;

    const intervalId = window.setInterval(() => {
      void runPoll();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, runPoll]);

  return {
    polling,
    lastPolledAt,
    registerPollRunner,
    runPoll,
  };
}
