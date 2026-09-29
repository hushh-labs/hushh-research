"use client";

import { ChevronRight } from "@/components/icons";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

type FollowUpMessage = {
  id: string;
  role: "user" | "assistant";
  status?: "streaming" | "done" | "error";
  followUps?: string[];
};

/**
 * Chips only belong to the newest settled answer. Once the person sends the
 * next turn that answer is no longer last, so its chips disappear without any
 * extra bookkeeping; reloaded history never carries them.
 */
export function visibleFollowUps(
  message: FollowUpMessage,
  latestMessageId: string | null | undefined,
  busy: boolean,
): string[] {
  if (busy || message.id !== latestMessageId) return [];
  if (message.role !== "assistant" || message.status !== "done") return [];
  return message.followUps ?? [];
}

/**
 * Tapping a follow-up fills the composer, exactly like the welcome chips: the
 * person can read, edit, or discard it before anything is sent.
 *
 * Each chip is a plain button, so it carries the shared ripple itself and
 * `relative overflow-hidden` gives that ripple a box to fill and clip to.
 */
export function AgentFollowUpSuggestions({
  suggestions,
  onSelect,
}: {
  suggestions: readonly string[];
  onSelect: (suggestion: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      data-testid="agent-follow-up-suggestions"
      role="group"
      aria-label="Suggested follow-ups"
      className="motion-step-enter -mt-1 mb-2 flex max-w-[90%] flex-wrap justify-start gap-2 sm:max-w-[min(82%,48rem)]"
    >
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onSelect(suggestion)}
          className="relative inline-flex !h-auto !min-h-11 max-w-full items-center gap-2 overflow-hidden !rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] !px-3.5 !py-2 text-left text-sm font-medium text-foreground shadow-[var(--app-glass-shadow)] transition-colors duration-150 hover:bg-[color:var(--app-shell-surface-bg-hover)] active:opacity-90"
        >
          <span className="min-w-0 whitespace-normal leading-5">{suggestion}</span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]"
            aria-hidden
          />
          <MaterialRipple variant="none" effect="glass" />
        </button>
      ))}
    </div>
  );
}
