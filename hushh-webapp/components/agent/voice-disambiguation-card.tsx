"use client";

import { User } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";

import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { Button } from "@/lib/morphy-ux/button";
import {
  clearVoiceDisambiguation,
  readVoiceDisambiguation,
  subscribeToVoiceDisambiguation,
  type VoiceDisambiguationCandidate,
} from "@/lib/voice/voice-disambiguation";

/**
 * The list One shows when it cannot tell two people apart.
 *
 * Voice used to answer an ambiguous name with "say which one", which is
 * unanswerable when the duplicates share a display name -- the ordinary case,
 * not the edge one. What separates those accounts is the handle beneath the
 * name, so the choice has to be shown.
 *
 * The row deliberately mirrors the Connect list it is standing in for: avatar,
 * name, distinguishing detail underneath, the action's own button on the right.
 * Someone who has seen that list should recognise this immediately rather than
 * having to read a new kind of card mid-sentence.
 *
 * Tapping completes the request. This is not a confirmation step -- those were
 * removed on purpose and are not coming back through the side door. The person
 * already said what they wanted; the only thing missing was which of two
 * identical names they meant, and the tap supplies exactly that and nothing
 * else.
 */
export function VoiceDisambiguationCard() {
  const disambiguation = useSyncExternalStore(
    subscribeToVoiceDisambiguation,
    readVoiceDisambiguation,
    () => null,
  );
  const [runningId, setRunningId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const choose = useCallback(
    async (candidate: VoiceDisambiguationCandidate) => {
      if (!disambiguation || runningId) return;
      const handler = resolveLocalOnboardingHandler(disambiguation.actionId);
      if (!handler) {
        // The surface unmounted between asking and answering -- navigated away,
        // or signed out. Say so rather than clearing the card and leaving the
        // person wondering whether their tap did anything.
        setFailure("That screen is no longer open. Ask again to retry.");
        return;
      }
      setRunningId(candidate.id);
      setFailure(null);
      try {
        const result = await handler({
          ...disambiguation.slots,
          [disambiguation.resolveSlot]: candidate.id,
        });
        if (result.status === "blocked" || result.status === "failed") {
          // Keep the card up. The other candidate may well be the right one,
          // and dismissing it here would put the person back at the dead end
          // this card exists to remove.
          setFailure(result.summary);
          return;
        }
        clearVoiceDisambiguation();
      } catch (error) {
        setFailure(
          error instanceof Error && error.message
            ? error.message
            : "That did not go through. Try the other one, or ask again.",
        );
      } finally {
        setRunningId(null);
      }
    },
    [disambiguation, runningId],
  );

  if (!disambiguation) return null;

  return (
    <div
      // Same glass treatment as the approval card this replaces, so it reads as
      // the surface the person already knows rather than a new kind of popup.
      className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="voice-disambiguation-card"
      role="dialog"
      aria-label={disambiguation.prompt}
    >
      <p className="pb-2 text-[13px] font-medium text-muted-foreground">
        {disambiguation.prompt}
      </p>

      <ul className="flex flex-col">
        {disambiguation.candidates.map((candidate, index) => {
          const isRunning = runningId === candidate.id;
          const isDisabled =
            Boolean(candidate.disabledReason) || (runningId !== null && !isRunning);
          return (
            <li
              key={candidate.id}
              className={
                index > 0 ? "flex items-center gap-3 border-t border-border/40 py-2" : "flex items-center gap-3 py-2"
              }
              data-testid="voice-disambiguation-row"
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
              >
                <User className="size-4" />
              </span>

              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {candidate.name}
                </span>
                {/* The only thing telling these rows apart, so it never
                    truncates away entirely and never falls back to silence. */}
                <span className="truncate text-xs text-muted-foreground">
                  {candidate.detail ?? candidate.disabledReason ?? "No other details"}
                </span>
              </span>

              <Button
                type="button"
                // Same control the Connect list renders for these people, so
                // the button in the card is the button they already know.
                variant="none"
                effect="fill"
                size="sm"
                disabled={isDisabled || isRunning}
                onClick={() => void choose(candidate)}
                // Two rows share a name, so the name alone cannot say which
                // button this is. Screen readers get the detail too.
                aria-label={`${candidate.actionLabel} ${candidate.name}${
                  candidate.detail ? `, ${candidate.detail}` : ""
                }`}
              >
                {isRunning ? "Working…" : candidate.actionLabel}
              </Button>
            </li>
          );
        })}
      </ul>

      {failure ? (
        <p className="px-1 pt-1 text-xs text-destructive" role="status">
          {failure}
        </p>
      ) : null}

      <div className="flex justify-end pt-1">
        <Button
          type="button"
          size="sm"
          variant="none"
          onClick={() => clearVoiceDisambiguation()}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
