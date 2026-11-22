"use client";

import { cn } from "@/lib/utils";

/**
 * Real, phase-accurate pending labels for a live One turn.
 *
 * Never invent speculative activity copy (for example rotating fake "wiki" or
 * "distilling" verbs before the sandbox is even awake). Only surface the true
 * runtime phase emitted by wake, session unlock, reconnect, or active SSE work.
 */
export type OneTurnPendingPhase =
  | "waking"
  | "unlocking"
  | "thinking"
  | "working"
  | "reconnecting";

export const ONE_TURN_PHASE_LABELS: Readonly<Record<OneTurnPendingPhase, string>> = {
  waking: "Waking your sandbox…",
  unlocking: "Unlocking memory…",
  thinking: "Thinking…",
  working: "Working…",
  reconnecting: "Reconnecting to One…",
};

/**
 * Retained for compatibility with existing imports; contains only the real,
 * non-speculative base phase label rather than rotating fictional verbs.
 */
export const ONE_PERSONA_THINKING_PHRASES = [
  ONE_TURN_PHASE_LABELS.thinking,
] as const;

export function OneThinkingIndicator({
  phase = "thinking",
  label,
  className,
}: {
  phase?: OneTurnPendingPhase;
  label?: string | null;
  className?: string;
}) {
  const displayLabel =
    typeof label === "string" && label.trim().length > 0
      ? label.trim()
      : ONE_TURN_PHASE_LABELS[phase];

  return (
    <span
      data-testid="one-thinking-indicator"
      data-turn-phase={phase}
      className={cn(
        "inline-flex items-center gap-2.5 py-0.5 text-[13.5px] leading-6 text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-foreground/45 motion-safe:animate-pulse" />
        <span className="size-1.5 rounded-full bg-foreground/35 motion-safe:animate-pulse [animation-delay:220ms]" />
        <span className="size-1.5 rounded-full bg-foreground/25 motion-safe:animate-pulse [animation-delay:440ms]" />
      </span>
      <span>{displayLabel}</span>
    </span>
  );
}
