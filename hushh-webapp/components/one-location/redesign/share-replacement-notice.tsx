"use client";

/**
 * Saying out loud that a new share REPLACES the one already running.
 *
 * Starting a share with somebody who can already see you does not extend their
 * access — the backend revokes the live grant in the same lane and inserts a
 * new one. Choosing a shorter duration therefore takes time away, and the
 * confirm step used to state the new end time as if nothing else were in play.
 * Two facts have to reach the owner before the button, not after it: how much
 * time is being given up, and for whom.
 *
 * Split out of `location-redesign-hub.tsx` on purpose. The hub carries a
 * source-text contract banning `<WarningCard` (the amber banner that once
 * argued against the button below it on the Links screen), and honouring the
 * intent of that ban — no amber arguing with a CTA it sits above — is easier
 * to hold in a component that is only ever this one warning. It also makes the
 * copy testable without rendering a 14k-line screen.
 *
 * Presentational only: it is handed rows that are already labelled and already
 * formatted, so nothing here reads a clock or a view model.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { WarningCard } from "./primitives";
import { MUTED_TEXT } from "./tokens";

export type ShareReplacementRow = {
  recipientUserId: string;
  /** The person, named exactly as the rest of the flow names them. */
  label: string;
  /**
   * Whether their live share runs until it is stopped.
   *
   * The sentence branches on this rather than the noun. "Aarti has Until you
   * stop." is not a sentence, and this copy sits on the screen whose whole job
   * is being understood before a button is pressed.
   */
  untilStopped: boolean;
  /**
   * What is left, standalone: "1h 47m more", or "Until you stop".
   *
   * `formatLocationRemaining` supplies the timed form -- the same words the
   * approvals card, the feed and the Consent Manager use for "what is actually
   * left", so this screen does not invent a fifth vocabulary for one fact.
   */
  remainingLabel: string;
};

/** "Aarti can see you for 1h 47m more" / "Aarti can see you until you stop". */
function canSeeYouClause(row: ShareReplacementRow): string {
  return row.untilStopped
    ? `${row.label} can see you until you stop`
    : `${row.label} can see you for ${row.remainingLabel}`;
}

/**
 * The heading both surfaces use, so the inline notice and the dialog that
 * follows it cannot describe the same situation two different ways.
 */
function replacementTitle(count: number): string {
  return count === 1 ? "This replaces a live share" : "This replaces live shares";
}

/**
 * The amber read-back under the confirm step's recipient rail.
 *
 * Renders nothing when there is nothing to give up, which is the ordinary case
 * — a first share, or a longer one. A warning that appears on every share is a
 * warning nobody reads.
 */
export function ShareReplacementNotice({
  rows,
  newDurationLabel,
}: {
  rows: ShareReplacementRow[];
  /** "15 min", "2 hours" — what the picker is currently set to. */
  newDurationLabel: string;
}) {
  if (!rows.length) return null;
  const single = rows.length === 1;
  return (
    <div
      className="space-y-2"
      data-testid="one-location-share-replacement-notice"
    >
      <WarningCard
        title={replacementTitle(rows.length)}
        description={
          single && rows[0]
            ? // Names the person here rather than in the list below: with one
              // row a list is a bullet on its own, and the sentence reads
              // better carrying the name than pointing at it.
              `${canSeeYouClause(rows[0])}. Sharing again ends that and starts ${newDurationLabel} instead.`
            : `Sharing again ends the time these people already have and starts ${newDurationLabel} instead.`
        }
      />
      {single ? null : (
        <ul className="space-y-1 pl-1">
          {rows.map((row) => (
            <li
              key={row.recipientUserId}
              className={`${MUTED_TEXT} flex items-baseline justify-between gap-3 text-[13px]`}
              data-testid="one-location-share-replacement-row"
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.remainingLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The stop-and-look-at-it step between "Start sharing" and the network call.
 *
 * The inline notice above states the consequence; this makes the owner agree to
 * it. Deliberately NOT `variant="destructive"`: the semantic roles reserve
 * danger for a real loss, and this is time being traded rather than a share
 * being torn down — the person keeps seeing you, for less long. Cancel returns
 * to the confirm step with the duration still set, so changing the number is
 * one tap away.
 */
export function ShareReplacementConfirmDialog({
  open,
  onOpenChange,
  rows,
  newDurationLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ShareReplacementRow[];
  newDurationLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  if (!rows.length) return null;
  const single = rows.length === 1;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single ? "End the share you have?" : "End the shares you have?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single && rows[0]
              ? `${canSeeYouClause(rows[0])}. Starting a new share replaces that with ${newDurationLabel}.`
              : `These people can already see you. Starting a new share replaces the time they have with ${newDurationLabel}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {single ? null : (
          <ul
            className="space-y-1.5"
            data-testid="one-location-share-replacement-confirm-list"
          >
            {rows.map((row) => (
              <li
                key={row.recipientUserId}
                className="flex items-baseline justify-between gap-3 text-[13px]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {row.label}
                </span>
                <span className={`${MUTED_TEXT} shrink-0 tabular-nums`}>
                  {row.remainingLabel} → {newDurationLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="one-location-share-replacement-cancel">
            Keep current
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="one-location-share-replacement-accept"
            disabled={busy}
            onClick={onConfirm}
            className="h-11 w-full sm:w-auto"
          >
            Start sharing
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
