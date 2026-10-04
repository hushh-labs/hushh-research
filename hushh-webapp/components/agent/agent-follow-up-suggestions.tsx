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
 * Suggestions only belong to the newest settled answer. Once the person sends the
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
 * Tapping a follow-up fills the composer, exactly like welcome suggestions: the
 * person can read, edit, or discard it before anything is sent.
 *
 * Each suggestion is a semantic button with a quiet text-row presentation and
 * a 44-point target. It carries the shared ripple itself and
 * `relative overflow-hidden` gives that ripple a box to fill and clip to.
 */
export function AgentFollowUpSuggestions({
  suggestions,
  onSelect,
}: {
  suggestions: readonly string[];
  onSelect: (suggestion: string) => void;
}) {
  return (
    <AgentSuggestionList
      suggestions={suggestions}
      label="Suggested follow-ups"
      testId="agent-follow-up-suggestions"
      onSelect={onSelect}
    />
  );
}

/** Welcome and response suggestions share geometry, focus and press feedback. */
export function AgentSuggestionList({ suggestions, label, testId, disabled = false, onSelect }: {
  suggestions: readonly string[];
  label: string;
  testId: string;
  disabled?: boolean;
  onSelect: (suggestion: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      data-testid={testId}
      role="group"
      aria-label={label}
      className="mb-2 flex w-full max-w-2xl flex-col items-start gap-0.5 text-left"
    >
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className="relative inline-flex !h-auto !min-h-11 max-w-full items-center !justify-start gap-2 overflow-hidden !rounded-lg !border-0 !bg-transparent !px-2 !py-2 text-left text-sm font-medium text-muted-foreground !shadow-none transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 active:!scale-100 disabled:pointer-events-none disabled:opacity-60"
        >
          <span className="min-w-0 whitespace-normal leading-5">{suggestion}</span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]"
            aria-hidden
          />
          <MaterialRipple variant="none" effect="glass" disabled={disabled} />
        </button>
      ))}
    </div>
  );
}
