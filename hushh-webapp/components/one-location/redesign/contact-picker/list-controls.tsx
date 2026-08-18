"use client";

import { useEffect, useState } from "react";

import { PersonSearchInput } from "@/components/one-location/redesign/selectors";
import {
  CONTACT_SORT_MODES,
  shouldRevealListControls,
  type ContactSortMode,
} from "@/lib/one-location/contact-picker-controls";
import { cn } from "@/lib/utils";

/**
 * Search and sort for one list — present only while that list is long enough
 * to need them.
 *
 * The reveal decision lives in `shouldRevealListControls`, and the two
 * properties it protects are worth restating where the component uses it:
 *
 *   * `sourceCount` is the section's FULL length, never the filtered result.
 *     Measuring the filtered list would make this control delete itself: type
 *     a query, 40 rows become 4, the field unmounts, the query dies with it,
 *     the list returns to 40, the field remounts.
 *   * Once revealed it stays revealed for as long as the section is mounted,
 *     so removing people one at a time cannot pull the field out from under a
 *     half-typed query.
 */
export function ContactListControls({
  sourceCount,
  query,
  onQueryChange,
  sortMode,
  onSortModeChange,
  placeholder,
  voiceControlId,
  resultCount,
}: {
  sourceCount: number;
  query: string;
  onQueryChange: (next: string) => void;
  sortMode: ContactSortMode;
  onSortModeChange: (next: ContactSortMode) => void;
  placeholder: string;
  voiceControlId?: string;
  /** Rows currently on screen, announced politely while a query is active. */
  resultCount: number;
}) {
  // State, not a ref: the latch has to survive re-renders AND be allowed to
  // cause one. It only ever moves false -> true, which is the whole point --
  // `shouldRevealListControls` is handed the current value so the rule itself
  // stays in one tested place rather than being re-implemented here.
  const [revealed, setRevealed] = useState(() =>
    shouldRevealListControls(sourceCount),
  );
  useEffect(() => {
    setRevealed((current) => shouldRevealListControls(sourceCount, current));
  }, [sourceCount]);

  // A list that was already long on first render has always had its controls;
  // animating them in on load would be a glitch, not a reveal. Only a list
  // that GROWS past the threshold gets the transition.
  const [entered, setEntered] = useState(() =>
    shouldRevealListControls(sourceCount),
  );
  useEffect(() => {
    if (!revealed || entered) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [entered, revealed]);

  if (!revealed) return null;

  const queryActive = query.trim().length > 0;

  return (
    <div
      data-testid="contact-list-controls"
      className={cn(
        "grid gap-2 overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        entered ? "mb-3 max-h-40 opacity-100" : "mb-0 max-h-0 opacity-0",
      )}
    >
      <PersonSearchInput
        value={query}
        onChange={onQueryChange}
        placeholder={placeholder}
        voiceControlId={voiceControlId}
      />
      <div
        className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label="Sort contacts"
      >
        {CONTACT_SORT_MODES.map((mode) => {
          const active = mode.value === sortMode;
          return (
            <button
              key={mode.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSortModeChange(mode.value)}
              className={cn(
                "press-scale h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold transition-colors",
                active
                  ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                  : "bg-[color:var(--app-neutral-fill-strong)] text-foreground",
              )}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      {/* A filtered list that comes back empty has to say so out loud, or the
          only feedback for a typo is rows silently vanishing. */}
      <p className="sr-only" role="status" aria-live="polite">
        {queryActive
          ? `${resultCount} ${resultCount === 1 ? "result" : "results"}`
          : ""}
      </p>
    </div>
  );
}
