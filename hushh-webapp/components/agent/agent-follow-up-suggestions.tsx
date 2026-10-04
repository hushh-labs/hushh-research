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

/** Welcome uses equal grid tracks; follow-ups keep a compact list. Both retain
 * the same edit-before-send selection, focus and flat ripple contracts. */
export function AgentSuggestionList({ suggestions, label, testId, disabled = false, layout = "list", onSelect }: {
  suggestions: readonly string[];
  label: string;
  testId: string;
  disabled?: boolean;
  layout?: "list" | "starter-grid";
  onSelect: (suggestion: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      data-testid={testId}
      role="group"
      aria-label={label}
      className={layout === "starter-grid"
        ? "mt-6 mb-2 grid w-full max-w-2xl grid-cols-1 auto-rows-fr gap-3 text-left sm:grid-cols-3 sm:gap-6"
        : "mb-2 flex w-full max-w-2xl flex-col items-start gap-0.5 text-left"}
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className={`relative inline-flex !h-auto max-w-full !justify-start overflow-hidden !rounded-lg !border-0 !bg-transparent text-left text-sm font-medium !shadow-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 active:!scale-100 disabled:pointer-events-none disabled:opacity-60 ${layout === "starter-grid"
            ? "!min-h-[72px] w-full items-center gap-4 !px-0 !py-3 text-foreground hover:text-[color:var(--app-accent-deep)] sm:!min-h-[128px] sm:flex-col sm:items-start sm:gap-3"
            : "!min-h-11 items-center gap-2 !px-2 !py-2 text-muted-foreground hover:text-foreground"}`}
        >
          {layout === "starter-grid" ? (
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center gap-1 text-[color:var(--app-accent-deep)]">
              <span className="text-xs font-medium tabular-nums">{String(index + 1).padStart(2, "0")}</span>
              <ChevronRight className="h-3 w-3" />
            </span>
          ) : null}
          <span className="min-w-0 whitespace-normal leading-6">{suggestion}</span>
          {layout === "list" ? <ChevronRight
            className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]"
            aria-hidden
          /> : null}
          <MaterialRipple variant="none" effect="glass" disabled={disabled} />
        </button>
      ))}
    </div>
  );
}
