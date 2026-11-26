"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** Serializes visible owner actions and stops continuations when the review closes. */
export function useLocationChatMutation() {
  const lifetime = useRef<AbortController>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const unsubscribe = subscribeVaultSessionEpoch(() => controller.abort());
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, []);

  const run = useCallback(async (
    task: (signal: AbortSignal) => Promise<string>,
    fallback: string,
  ): Promise<boolean> => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current) return false;
    running.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const summary = await task(signal);
      if (signal.aborted) return false;
      setNotice(summary);
      return true;
    } catch (caught) {
      if (!signal.aborted) setError(oneLocationErrorMessage(caught, fallback));
      return false;
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }, []);

  return { busy, error, notice, run };
}
