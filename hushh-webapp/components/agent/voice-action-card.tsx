"use client";

import { User } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";

import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { Button } from "@/lib/morphy-ux/button";
import {
  clearVoiceCard,
  readVoiceCard,
  subscribeToVoiceCard,
  type VoiceDisambiguationCandidate,
} from "@/lib/voice/voice-action-card";

/** The row treatment shared by both shapes: avatar, name, detail beneath. */
function SubjectRow({
  name,
  detail,
}: {
  name: string;
  detail?: string | null;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
      >
        <User className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {detail ?? "No other details"}
        </span>
      </span>
    </>
  );
}

/**
 * The one surface One raises when a sentence alone cannot finish the job.
 *
 * Two shapes, because there are exactly two reasons a spoken request stalls:
 *
 *   choice  -- more than one person matches the name. Answering "say which
 *              one" is impossible when the duplicates share a display name,
 *              which is the ordinary case; what separates them is the handle
 *              beneath the name, so it has to be seen.
 *   confirm -- the action cannot be taken back. "Remove Rashid" spoken once,
 *              misheard once, is a connection gone with no undo.
 *
 * Neither is the old confirmation returning. That was a blanket "are you
 * sure?" on every action, which is tiring and adds nothing a sentence did not
 * already carry. `choice` asks for information the sentence genuinely lacked,
 * and `confirm` is scoped to effects that cannot be reversed, opt-in per
 * handler rather than derived from a risk field.
 *
 * Both reuse the app's own controls and row anatomy, so someone who has used
 * the Connect list recognises this instead of reading a new kind of popup
 * mid-sentence.
 */
export function VoiceActionCard() {
  const card = useSyncExternalStore(subscribeToVoiceCard, readVoiceCard, () => null);
  const disambiguation = card?.kind === "choice" ? card : null;
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
        clearVoiceCard();
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

  const confirm = card?.kind === "confirm" ? card : null;
  const confirmAction = useCallback(async () => {
    if (!confirm || runningId) return;
    const handler = resolveLocalOnboardingHandler(confirm.actionId);
    if (!handler) {
      setFailure("That screen is no longer open. Ask again to retry.");
      return;
    }
    setRunningId(confirm.actionId);
    setFailure(null);
    try {
      const result = await handler({ ...confirm.slots, confirmed: true });
      if (result.status === "blocked" || result.status === "failed") {
        setFailure(result.summary);
        return;
      }
      clearVoiceCard();
    } catch (error) {
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : "That did not go through. Ask again to retry.",
      );
    } finally {
      setRunningId(null);
    }
  }, [confirm, runningId]);

  if (confirm) {
    const busy = runningId === confirm.actionId;
    return (
      <div
        className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
        data-testid="voice-confirm-card"
        role="alertdialog"
        aria-label={confirm.prompt}
      >
        <p className="pb-2 text-[13px] font-medium text-foreground">{confirm.prompt}</p>

        {confirm.subject ? (
          <div className="flex items-center gap-3 py-2">
            <SubjectRow name={confirm.subject.name} detail={confirm.subject.detail} />
          </div>
        ) : null}

        {confirm.consequence ? (
          // The action's own `meaning` from the generated contract, so what the
          // person is warned about stays true when the behaviour changes.
          <p className="pt-1 text-xs text-muted-foreground">{confirm.consequence}</p>
        ) : null}

        {failure ? (
          <p className="pt-2 text-xs text-destructive" role="status">
            {failure}
          </p>
        ) : null}

        {/* Cancel left, destructive right, and the same pair the Connect list
            already uses for this exact decision -- same variants, effects and
            sizing, so it behaves like the app rather than merely resembling it. */}
        <div className="flex justify-end gap-2 pt-3">
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="sm"
            className="h-8 rounded-[10px] px-3 text-[13px] font-medium"
            disabled={busy}
            onClick={() => clearVoiceCard()}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            effect="fill"
            size="sm"
            className="h-8 rounded-[10px] px-3 text-[13px] font-medium"
            disabled={busy}
            onClick={() => void confirmAction()}
          >
            {busy ? "Working…" : confirm.confirmLabel}
          </Button>
        </div>
      </div>
    );
  }

  if (!disambiguation) return null;

  return (
    <div
      // Same glass treatment as the approval card this replaces, so it reads as
      // the surface the person already knows rather than a new kind of popup.
      className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="voice-choice-card"
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
              data-testid="voice-action-card-row"
            >
              {/* The detail line is the only thing telling these rows apart, so
                  it falls back to the disabled reason before it falls silent. */}
              <SubjectRow
                name={candidate.name}
                detail={candidate.detail ?? candidate.disabledReason}
              />

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
          onClick={() => clearVoiceCard()}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
