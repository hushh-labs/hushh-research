/**
 * Which live shares a NEW share is about to cut short.
 *
 * Starting a share does not add to what a person already has: the backend
 * revokes the live grant in the same lane and inserts a fresh one
 * (`_create_enforced_grant_row` / `create_grant` in
 * `one_location_agent_service.py`, both revoke-then-insert). So picking someone
 * who can already see you for two more hours and choosing "15 minutes" does not
 * give them two hours and fifteen minutes — it takes an hour and forty-five
 * minutes away, and until this module existed nothing on screen said so. The
 * share flow's step 1 shows the remaining time on the row, but the duration is
 * chosen on step 2, where the number that would replace it was never compared
 * against the number already running.
 *
 * Reported as: "I shared for 2 hours, then next cycle shared 15 minutes with the
 * same person, and the previous share timed out into the new duration without
 * any alert."
 *
 * Pure and clock-free: the caller passes `nowMs` so a screen can tick on one
 * timer and every row agrees on what time it is, the same contract
 * `lib/one-location/duration-copy.ts` and `share-countdown.ts` keep.
 */

import {
  grantDurationEditIntent,
  grantExpiryMs,
} from "@/lib/one-location/grant-duration-edit";
import { groupGrantsByCounterpart } from "@/lib/one-location/grant-lanes";
import type { OneLocationGrant } from "@/lib/one-location/types";

/**
 * The duration this picker value actually posts, or `null` for open-ended.
 *
 * Deliberately the same clamp `privateShareDurationPayload` applies in
 * `app/one/location/page.tsx` before it builds the request body. A warning that
 * compared a different number from the one on the wire would be capable of
 * promising a share it does not create — so the two must not drift, and the
 * page delegates here rather than keeping its own copy.
 */
export function resolveShareDurationHours(value: string): number | null {
  if (value === "until_stopped") return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.min(24, Math.max(0.25, hours)) : 0.25;
}

export type ShareReplacement = {
  recipientUserId: string;
  /** The ordinary-lane grant this new share will revoke. */
  grant: OneLocationGrant;
  /**
   * True when the live share runs until it is stopped. The worst case: an
   * open-ended share replaced by a timed one hands back an end time the owner
   * never asked for, and there is no remaining figure to quote.
   */
  untilStopped: boolean;
};

/**
 * The people whose live share would END SOONER if this share were started now.
 *
 * Returns them in the order they were selected, so the warning names them in
 * the order they appear on screen. Empty when nothing is lost — a longer
 * duration, an untouched one, or a recipient with no live share at all — which
 * is what keeps this silent for the ordinary case of extending a share.
 */
export function shareReplacementsLosingTime(input: {
  /** Selected recipients, in selection order. */
  recipientUserIds: string[];
  /** The owner's live outgoing grants, exactly as the workspace state holds them. */
  activeOwnerGrants: OneLocationGrant[];
  /** The share flow's duration picker value ("0.25", "2", "until_stopped"). */
  durationValue: string;
  nowMs: number;
}): ShareReplacement[] {
  const { recipientUserIds, activeOwnerGrants, durationValue, nowMs } = input;
  const durationHours = resolveShareDurationHours(durationValue);
  // An open-ended share can only ever be an extension of a timed one, and
  // replacing an open-ended share with another takes nothing away.
  if (durationHours === null) return [];

  // ORDINARY lane only. Replacement is lane-scoped on the backend
  // (`_share_lane_match_sql`), so a plain share never supersedes a live Save My
  // Soul share — warning about SOS time that this tap would not touch would be
  // a false alarm on the one screen that must not cry wolf. Note this is
  // `ordinaryGrant` alone, without the `?? primaryGrant` fallback the picker row
  // uses: a person holding ONLY an SOS grant has nothing at risk here.
  const ordinaryByRecipient = new Map(
    groupGrantsByCounterpart(activeOwnerGrants, "owner")
      .filter((group) => group.ordinaryGrant)
      .map((group) => [
        group.counterpartUserId,
        group.ordinaryGrant as OneLocationGrant,
      ]),
  );

  const replacements: ShareReplacement[] = [];
  for (const recipientUserId of recipientUserIds) {
    const grant = ordinaryByRecipient.get(recipientUserId);
    if (!grant) continue;
    if (grant.durationMode === "until_stopped") {
      replacements.push({ recipientUserId, grant, untilStopped: true });
      continue;
    }
    const expiry = grantExpiryMs(grant);
    // No readable expiry on a timed grant leaves nothing honest to quote, and
    // an alert that cannot say how much is being taken is worse than none. The
    // server is the authority on that grant either way.
    if (expiry === null || expiry <= nowMs) continue;
    // Reuses the owner duration editor's own comparison so the two surfaces
    // that change a live share's length agree on what counts as shorter. It
    // carries the tolerance (5% of the picked duration, never under two
    // minutes) that stops a 1-hour share with 59 minutes left from reading as
    // a shortening when it is re-shared for 1 hour — the most common re-share
    // there is, and the one this warning must stay quiet about.
    if (grantDurationEditIntent({ grant, durationHours, nowMs }) !== "shorten") {
      continue;
    }
    replacements.push({ recipientUserId, grant, untilStopped: false });
  }
  return replacements;
}
