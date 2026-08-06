"use client";

import { useEffect, useState } from "react";

const SAGE_STATUS_MESSAGES = [
  "Reading your question…",
  "Searching the web…",
  "Reading sources…",
  "Cross-checking facts…",
  "Structuring the answer…",
  "Writing a thorough answer…",
  "Double-checking the details…",
  "Wrapping up…",
];

function useCyclingStatus(active: boolean, messages: string[], intervalMs: number): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const id = setInterval(() => {
      setIndex((current) => Math.min(current + 1, messages.length - 1));
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, messages.length]);
  return messages[index] ?? messages[0] ?? "";
}

function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

/**
 * Sage's own research calls can legitimately run 8-75s (deep mode's
 * "exhaustive" length tier, or challenge mode's two-stage search) -- a
 * static "Researching…" label over that long reads as stalled. Paces a
 * cycling status line and an elapsed-time readout against how long the
 * call is actually expected to take, plus an indeterminate progress sweep
 * (there's no real step-by-step progress from this single-call endpoint,
 * so this never claims to be a literal percentage).
 */
export function SageLoadingIndicator({
  active,
  expectedSeconds = 20,
}: {
  active: boolean;
  /** Roughly how long this call is expected to take -- used only to pace
   * the status-message cycle and decide when to show the "still working"
   * reassurance, never rendered as a literal countdown or percentage. */
  expectedSeconds?: number;
}) {
  const statusMessage = useCyclingStatus(
    active,
    SAGE_STATUS_MESSAGES,
    (expectedSeconds * 1000) / SAGE_STATUS_MESSAGES.length,
  );
  const elapsedSeconds = useElapsedSeconds(active);

  if (!active) return null;

  const longWait = elapsedSeconds > expectedSeconds;

  return (
    <div className="mt-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <span className="inline-flex items-center gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-160ms] motion-reduce:animate-none" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-80ms] motion-reduce:animate-none" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
          </span>
          <span>{statusMessage}</span>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
          {elapsedSeconds}s
        </span>
      </div>
      <div className="relative mt-2.5 h-1 overflow-hidden rounded-full bg-emerald-500/10">
        <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-emerald-500/80 to-transparent animate-sage-progress-sweep motion-reduce:animate-none" />
      </div>
      {longWait ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Still working -- a genuinely thorough answer just takes longer than a quick one.
        </p>
      ) : null}
    </div>
  );
}
