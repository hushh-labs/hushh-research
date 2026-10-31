"use client";

import { Check, MinusCircle, ShieldOff } from "@/components/icons";
import type { ConsentOutcome } from "@/lib/consent/open-granted-person-information";

/**
 * Right-aligned user-side chip summarizing a card selection, styled to match the
 * central chat's primary user bubble so both surfaces read consistently.
 *
 * The glyph follows what happened, never a check for something that did not:
 * - `ended` is a sharing that has since stopped ("Kushal stopped sharing Food
 *   preferences"): the same neutral ended mark as the "Access ended" notice;
 * - a declined request ("Kushal declined") carries the card's neutral "Not
 *   shared" mark. Localhost run 4 (R6) showed it with a check, which read as
 *   a success.
 */
export function SelectionChip({ label, ended = false, outcome = null }: {
  label: string;
  ended?: boolean;
  /** What a consent chip reports; any other chip is a plain selection. */
  outcome?: ConsentOutcome | null;
}) {
  const state = ended || outcome === "revoked" || outcome === "expired" ? "ended"
    : outcome === "denied" ? "declined" : "done";
  const Icon = state === "ended" ? ShieldOff : state === "declined" ? MinusCircle : Check;
  return (
    <div className="flex w-full justify-end" data-testid="selection-chip" data-state={state}>
      <span className="inline-flex items-center gap-1.5 rounded-2xl bg-primary/10 px-3.5 py-1.5 text-sm font-medium text-primary shadow-sm shadow-primary/5">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    </div>
  );
}
