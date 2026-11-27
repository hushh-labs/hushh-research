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
  const explicitLabel =
    typeof label === "string" && label.trim().length > 0 ? label.trim() : null;
  const fallbackLabel = ONE_TURN_PHASE_LABELS[phase];
  const isGenericThinking =
    phase === "thinking" &&
    (!explicitLabel || /^thinking\.{0,3}$|^thinking…$/i.test(explicitLabel));
  const showVisibleLabel = !isGenericThinking;
  const accessibleLabel = explicitLabel ?? fallbackLabel;

  return (
    <span
      data-testid="one-thinking-indicator"
      data-turn-phase={phase}
      className={cn(
        "inline-flex items-center gap-2.5 py-1 text-[13.5px] leading-6 text-muted-foreground",
        className,
      )}
    >
      <span
        className="one-typing-rhythm inline-flex items-center gap-[5px] px-0.5 py-1"
        aria-hidden="true"
      >
        <span className="one-typing-rhythm-dot" />
        <span className="one-typing-rhythm-dot" />
        <span className="one-typing-rhythm-dot" />
      </span>
      {showVisibleLabel ? (
        <span>{accessibleLabel}</span>
      ) : (
        <span className="sr-only">{accessibleLabel}</span>
      )}
    </span>
  );
}
