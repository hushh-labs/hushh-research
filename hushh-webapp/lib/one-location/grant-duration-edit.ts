import type { OneLocationGrant } from "@/lib/one-location/types";

/**
 * How much time a live share has left, and what changing it would mean.
 *
 * Its first home was the recipient-side "New duration" editor, which offered
 * absolute lengths and decided from what you picked whether to shorten the
 * share or ask its owner for more. That control is gone: a single field
 * performing two opposite operations, with nothing on screen saying which side
 * of the line you were on, is what got reported. The recipient asks for time
 * additively now (`components/one-location/redesign/request-more-time`) and
 * ends a share with Remove.
 *
 * What survives is what was never about that control: reading the remaining
 * time off a grant, and -- for the OWNER's own live-share editor, which really
 * does set an absolute new length -- deciding whether a picked duration is
 * shorter, longer, or the same. No fetching, no formatting, no state.
 */

/** The picker value used when a grant tells us nothing usable about its length. */
export const GRANT_EDIT_DURATION_FALLBACK = "1";

type DurationGrantFields = Pick<OneLocationGrant, "expiresAt" | "durationHours">;

/** Milliseconds, or null when the timestamp is missing or unparseable. */
function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** When this grant runs out, in ms, or null for "no expiry we can read". */
export function grantExpiryMs(
  grant: DurationGrantFields | null | undefined,
): number | null {
  return timestamp(grant?.expiresAt);
}

/**
 * How long this share still has to run, in hours -- or null when there is no
 * readable expiry. Falls back to the granted length for a grant whose expiry
 * has not been sent, so the picker still opens on something true.
 */
export function grantRemainingHours(
  grant: DurationGrantFields | null | undefined,
  nowMs: number,
): number | null {
  const expiry = grantExpiryMs(grant);
  if (expiry !== null) {
    const remaining = expiry - nowMs;
    return remaining > 0 ? remaining / 3_600_000 : 0;
  }
  const granted = grant?.durationHours;
  return typeof granted === "number" && granted > 0 ? granted : null;
}

/**
 * How close a picked duration has to be to what is left before the two are
 * the same answer: 5% of the picked duration, never under two minutes.
 *
 * A one-hour share that has been running a minute reads as "59 more min" and
 * the picker opens on "1 hour", because that is what it is. Pressing Save on
 * that untouched field is not a request for one more minute of somebody's
 * location, and must not go out as one.
 */
function unchangedToleranceMs(durationHours: number): number {
  return Math.max(120_000, durationHours * 3_600_000 * 0.05);
}

/**
 * What Save does with this duration.
 *
 * "shorten" applies immediately -- the owner already agreed to be seen at
 * least this long, so giving time back needs nobody's permission.
 * "request" grows how long the recipient can watch the owner, which is the
 * owner's consent to give again. "unchanged" is the untouched picker: no
 * call, nothing to tell anyone, just close the editor.
 *
 * "shorten" is also the answer when the expiry is unknown, because then the
 * only authority on it is the backend, and its explicit shorten-only
 * rejection is what routes the call. Reading a stale or skewed clock here
 * must never cost the recipient the ability to end a share early.
 */
export type GrantDurationEditIntent = "shorten" | "request" | "unchanged";

export function grantDurationEditIntent(input: {
  grant: DurationGrantFields | null | undefined;
  durationHours: number;
  nowMs: number;
}): GrantDurationEditIntent {
  const { grant, durationHours, nowMs } = input;
  if (!Number.isFinite(durationHours) || durationHours <= 0) return "shorten";
  const expiry = grantExpiryMs(grant);
  // No expiry to compare against -- a share that runs until it is stopped can
  // only ever be shortened by naming a duration, and the backend agrees.
  if (expiry === null) return "shorten";
  const candidate = nowMs + durationHours * 3_600_000;
  if (Math.abs(candidate - expiry) <= unchangedToleranceMs(durationHours)) {
    return "unchanged";
  }
  return candidate < expiry ? "shorten" : "request";
}
