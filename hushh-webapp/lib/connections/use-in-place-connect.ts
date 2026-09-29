"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  InPlaceConnectOutcome,
  InPlaceConnectStart,
} from "@/lib/connections/google-connect-in-place";

export type InPlaceConnectControls = {
  signal: AbortSignal;
  cancelSignal: AbortSignal;
};

export type InPlaceConnectPending = {
  /** Which card or item owns the open attempt. */
  key: string;
  /** A consent window is open, so a Cancel sign-in control is meaningful. */
  cancellable: boolean;
};

export type InPlaceConnectFinish = (
  outcome: Exclude<InPlaceConnectOutcome, "stale">,
  detail: { cancelled: boolean; surface: InPlaceConnectStart["surface"] },
) => void;

/**
 * One in-place Google connect at a time for a chat surface: owns the pending
 * state, the explicit cancel, and a lifetime that silences late outcomes after
 * unmount. `begin` must open its window synchronously, so call `start` directly
 * from the click handler.
 */
export function useInPlaceConnect() {
  const lifetimeRef = useRef<AbortController | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<InPlaceConnectPending | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, []);

  const start = useCallback(
    (
      key: string,
      begin: (controls: InPlaceConnectControls) => InPlaceConnectStart,
      finish: InPlaceConnectFinish,
    ): "started" | "busy" | "blocked" | "unsupported" => {
      if (cancelRef.current) return "busy";
      const lifetime = lifetimeRef.current?.signal ?? new AbortController().signal;
      const cancel = new AbortController();
      const attempt = begin({ signal: lifetime, cancelSignal: cancel.signal });
      if (attempt.surface === "blocked" || attempt.surface === "unsupported") {
        void attempt.result;
        return attempt.surface;
      }
      cancelRef.current = cancel;
      setPending({ key, cancellable: attempt.surface === "window" });
      void attempt.result.then((outcome) => {
        if (cancelRef.current === cancel) cancelRef.current = null;
        if (lifetime.aborted) return;
        setPending(null);
        if (outcome === "stale") return;
        finish(outcome, {
          cancelled: cancel.signal.aborted,
          surface: attempt.surface,
        });
      });
      return "started";
    },
    [],
  );

  const cancel = useCallback(() => cancelRef.current?.abort(), []);

  return { pending, start, cancel };
}
