import type { OneLocationAccessRequest } from "@/lib/one-location/types";

/**
 * The shorter amounts an owner may approve an incoming request for.
 *
 * Reported: "i received access req for 4 hours from unknown, i can either
 * accept with same duration or deny ... if i want to edit the time, and want
 * to approve req for shorter duration i am not allowed to do so".
 *
 * Accurate, and the gap was only ever in the UI. `approveRequest` has taken
 * `durationHours` and `durationMode` since manual approval existed, and
 * `approveAccessRequest` already forwards a `durationHoursOverride` -- the card
 * simply never offered one except a single hard-coded "Allow 1 hour", which is
 * not a choice, and which vanished entirely for anything asked at an hour or
 * less. A person handed a four-hour ask from somebody they half-know had two
 * buttons: give them all of it, or give them nothing.
 *
 * SHORTER ONLY, NEVER LONGER
 *
 * Every option here is strictly less than what was asked. Approving MORE than
 * a request named would publish the owner's own location past the window
 * anybody asked for, from a screen whose whole job is answering somebody
 * else's question -- and the requester has a way to ask for more time already
 * (`extendsGrantId`, see `redesign/request-more-time`). Answering is not the
 * place to volunteer extra.
 */

/**
 * The lengths on offer, ascending. Deliberately the same five the rest of
 * Location speaks in, so an owner who has used any other duration control
 * recognises them -- and 0.25 is the backend floor (`MIN_DURATION_HOURS`), so
 * nothing here can be refused for being too small.
 */
export const APPROVE_SHORTER_HOURS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/**
 * How many fit on the card before it stops being a decision and starts being
 * a form. Four is two rows of two on the narrowest phone.
 */
export const APPROVE_SHORTER_MAX_OPTIONS = 4;

export type ApproveDurationOption = {
  hours: number;
  /** "15 min" / "1 hour" — what the button says. */
  label: string;
};

function labelFor(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * What this request may be approved for, below what it asked.
 *
 * An `until_stopped` ask has no ceiling, so every rung is shorter than it --
 * and this is the case where choosing matters most, because the alternative
 * is agreeing to be visible with no end at all.
 *
 * When more rungs qualify than fit, the LONGEST are kept. Somebody negotiating
 * a four-hour ask down is reaching for "an hour or two", not for the floor; the
 * floor stays reachable on the asks short enough for it to be a real answer.
 */
export function approveShorterDurationOptions(
  request: Pick<
    OneLocationAccessRequest,
    "requestedDurationHours" | "requestedDurationMode"
  >,
  limit: number = APPROVE_SHORTER_MAX_OPTIONS,
): ApproveDurationOption[] {
  const openEnded = request.requestedDurationMode === "until_stopped";
  const requested = Number(request.requestedDurationHours);
  const ceiling = openEnded
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(requested) && requested > 0
      ? requested
      : // No readable amount means there is nothing to be shorter THAN. An
        // older client or a referral request lands here, and guessing a
        // ceiling would offer the owner a "less" that might be more.
        0;
  if (ceiling <= 0) return [];

  const shorter = APPROVE_SHORTER_HOURS.filter((hours) => hours < ceiling);
  return shorter.slice(Math.max(0, shorter.length - limit)).map((hours) => ({
    hours,
    label: labelFor(hours),
  }));
}
