"use client";

import { Button } from "@/components/ui/button";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

/**
 * Asking the owner of a live share for more of it.
 *
 * WHY THIS IS A MODULE
 *
 * Two surfaces let you manage a share somebody else is giving you: the People
 * tab's "Requests sent" rows, and the roster on step 1 of Request location.
 * They disagreed, and one of them was wrong.
 *
 * People offered exactly this -- "30 min more", "2 hours more", "They'll need
 * to approve". Request location opened a `Select` labelled "New duration"
 * holding ABSOLUTE lengths (15 min / 30 min / 1 hour / 4 hours / 24 hours),
 * preselected to whichever was nearest what the share had left. Reported:
 *
 *   "4 hours ke liye approval maine le liya toh neeche ke time duration edit
 *    mein aana illogical ... agar deni hain toh user can ask for more time,
 *    let's say pehle 2 hours ka toh 30 minutes more ya 1 hour"
 *
 * The complaint is exactly right, and the absolute picker was worse than it
 * looked. It presented one field for two different operations -- picking under
 * what was left silently SHORTENED the share, picking over it asked the owner
 * for more -- with no label anywhere saying which side of the line you were on.
 * And the value that went out was already additive: the request carries
 * `extendsGrantId`, so the server reads `requestedDurationHours` as time ON TOP
 * of what is live. Choosing "24 hours" from a control that opened on "4 hours"
 * therefore asked for twenty-four hours MORE, while reading as "make it 24".
 *
 * Ending a share early was never lost with the shorten path: the roster row
 * carries Remove, and the People row carries Stop viewing, both of which stop
 * it outright. What is gone is a middle operation nobody could tell they were
 * performing.
 *
 * So there is one control, here, rendered by both surfaces -- every option
 * additive, every label saying so.
 */

/**
 * Four increments, ascending. `0.25` is the backend's floor
 * (`MIN_DURATION_HOURS`), which makes it the smallest thing anyone can ask for
 * and the right top-up for a share that is minutes from expiring.
 *
 * Four rather than two because the reporter's own example ("30 minutes more ya
 * 1 hour") named a rung the pair did not have -- and because four fills the
 * two-column phone grid exactly, where three would leave a ragged half-row.
 */
export const REQUEST_MORE_TIME_HOURS = [0.25, 0.5, 1, 2] as const;

export type RequestMoreTimeHours = (typeof REQUEST_MORE_TIME_HOURS)[number];

/**
 * "30 min more" / "1 hour more".
 *
 * Always suffixed, on every surface that names one of these amounts -- the
 * pending banner reads it back, and "2 hours" there would say the share is two
 * hours long rather than two hours longer.
 */
export function requestMoreTimeLabel(hours: number | null | undefined): string {
  const duration = formatLocationDurationLabel(hours);
  return duration ? `${duration} more` : "More time";
}

/**
 * The in-flight key. One person can have several amounts on screen, and only
 * the tapped one spins -- so the key is the pair, not the grant.
 */
export function requestMoreTimeKey(grantId: string, hours: number): string {
  return `${grantId}:${hours}`;
}

export function AskForMoreTime({
  grantId,
  ownerUserId,
  ownerLabel,
  pendingExtension,
  requestingMoreTimeKey,
  withdrawingRequestId,
  onRequestMoreTime,
  onWithdrawRequest,
  className,
}: {
  grantId: string;
  ownerUserId: string;
  ownerLabel: string;
  /** The extension already waiting on this grant, if there is one. */
  pendingExtension?: OneLocationAccessRequest | null;
  requestingMoreTimeKey: string | null;
  withdrawingRequestId: string | null;
  onRequestMoreTime: (params: {
    ownerUserId: string;
    grantId: string;
    ownerLabel: string;
    additionalHours: RequestMoreTimeHours;
  }) => void;
  onWithdrawRequest: (requestId: string) => void;
  className?: string;
}) {
  const busy = REQUEST_MORE_TIME_HOURS.some(
    (hours) => requestingMoreTimeKey === requestMoreTimeKey(grantId, hours),
  );

  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-[15px] font-semibold leading-5 text-foreground">
        Ask for more time
      </p>
      {pendingExtension ? (
        /* One ask at a time. Offering the amounts again under an ask already
           waiting is how somebody sends the same person four requests for the
           same share -- and the owner has to answer every one. */
        <div className="rounded-2xl bg-[color:var(--app-neutral-fill)] px-4 py-3">
          <p className="text-[15px] font-semibold leading-5 text-foreground">
            {requestMoreTimeLabel(pendingExtension.requestedDurationHours)}{" "}
            requested
          </p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
              Waiting for approval
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-[15px] font-medium text-[#FF3B30] hover:bg-transparent hover:text-[#D70015]"
              onClick={() => onWithdrawRequest(pendingExtension.id)}
              disabled={withdrawingRequestId === pendingExtension.id}
            >
              Take back
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Two columns from 340px, one below it. Four options make that an
              even 2x2 at every width the app supports. */}
          <div
            className="grid gap-2 min-[340px]:grid-cols-2"
            data-testid="one-location-more-time-options"
          >
            {REQUEST_MORE_TIME_HOURS.map((hours) => {
              const key = requestMoreTimeKey(grantId, hours);
              const label = requestMoreTimeLabel(hours);
              return (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  className="h-11 min-h-11 rounded-2xl border-[color:var(--app-accent)]/30 bg-[color:var(--app-primary-surface)] px-3 text-[15px] font-semibold leading-5 text-[color:var(--app-accent)] shadow-none hover:bg-[color:var(--app-accent-surface)] hover:text-[color:var(--app-accent)]"
                  // The visible label is the amount; the spoken one names who
                  // it is being asked of, because four buttons reading only
                  // "15 min more" tell a screen reader nothing about whose
                  // share they lengthen.
                  aria-label={`Ask ${ownerLabel} for ${label}`}
                  onClick={() =>
                    onRequestMoreTime({
                      ownerUserId,
                      grantId,
                      ownerLabel,
                      additionalHours: hours,
                    })
                  }
                  disabled={busy}
                  isLoading={requestingMoreTimeKey === key}
                >
                  {requestingMoreTimeKey === key ? "Requesting…" : label}
                </Button>
              );
            })}
          </div>
          {/* The whole point of the lane: none of these buttons takes time,
              they ask for it. */}
          <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
            They&rsquo;ll need to approve.
          </p>
        </>
      )}
    </div>
  );
}
