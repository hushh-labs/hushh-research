"use client";

import { User } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";

import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
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

        {/* Cancel left, destructive right, both full-width and 48px tall.
            The inline pair borrowed from the Connect list was 32px, which is
            fine under a mouse and under the 44pt iOS touch minimum on the
            build that actually ships to a phone. This matches the approval
            card's own two-up geometry instead, so every voice card presents
            its decision the same way at a thumb-sized target. */}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => clearVoiceCard()}
            className="h-12 rounded-full bg-black/[0.05] text-[15px] font-semibold ring-1 ring-inset ring-black/10 transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 dark:bg-white/[0.08] dark:ring-white/15 dark:hover:bg-white/[0.12]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirmAction()}
            // Tinted rather than filled: a solid red block reads as the
            // primary thing to press, and the safe choice should not have to
            // compete with it. Red text on a red-tinted ground says "this one
            // is the dangerous one" while leaving Cancel equally easy to hit.
            className="h-12 rounded-full bg-destructive/10 text-[15px] font-semibold text-destructive ring-1 ring-inset ring-destructive/35 transition-colors hover:bg-destructive/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50 dark:bg-destructive/[0.18] dark:ring-destructive/45 dark:hover:bg-destructive/25"
          >
            {busy ? "Working…" : confirm.confirmLabel}
          </button>
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
                index > 0
                  ? "flex items-center gap-3 border-t border-border/40 py-2.5"
                  : "flex items-center gap-3 py-2.5"
              }
              data-testid="voice-action-card-row"
            >
              {/* The detail line is the only thing telling these rows apart, so
                  it falls back to the disabled reason before it falls silent. */}
              <SubjectRow
                name={candidate.name}
                detail={candidate.detail ?? candidate.disabledReason}
              />

              <button
                type="button"
                disabled={isDisabled || isRunning}
                onClick={() => void choose(candidate)}
                // 44px, the iOS minimum, and a floor on the width so a short
                // label like "Connect" is not a sliver to aim at. A row cannot
                // give this the full 48px the decision buttons get without the
                // list growing taller than the card, but it must not be the
                // 32px inline control this started as.
                className="h-11 min-w-[92px] shrink-0 rounded-full bg-black/[0.05] px-4 text-[14px] font-semibold ring-1 ring-inset ring-black/10 transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45 dark:bg-white/[0.08] dark:ring-white/15 dark:hover:bg-white/[0.12]"
                // Two rows share a name, so the name alone cannot say which
                // button this is. Screen readers get the detail too.
                aria-label={`${candidate.actionLabel} ${candidate.name}${
                  candidate.detail ? `, ${candidate.detail}` : ""
                }`}
              >
                {isRunning ? "Working…" : candidate.actionLabel}
              </button>
            </li>
          );
        })}
      </ul>

      {failure ? (
        <p className="px-1 pt-1 text-xs text-destructive" role="status">
          {failure}
        </p>
      ) : null}

      {/* Cancel sits in the LEFT column, at the same size and in the same
          place as on every other voice card -- including the ones that have a
          second decision button beside it. It deliberately does not stretch
          across the width: the muscle memory for "where is the way out" only
          forms if the position never moves between variants. The right column
          stays empty because this card's actions live in the rows above. */}
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => clearVoiceCard()}
          className="h-12 rounded-full bg-black/[0.05] text-[15px] font-semibold ring-1 ring-inset ring-black/10 transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:bg-white/[0.08] dark:ring-white/15 dark:hover:bg-white/[0.12]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
