import type { OneLocationGrant } from "@/lib/one-location/types";
import { isSmsEmergencyGrant } from "./feed-task-projections";

/** Select before applying Clear. A cleared latest incident is still a tombstone. */
export function latestFeedSmsGrants(
  grants: readonly OneLocationGrant[],
  recipientId: string,
): OneLocationGrant[] {
  const latest = new Map<string, OneLocationGrant>();
  const instant = (value: string | null | undefined) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  for (const grant of grants) {
    if (
      !isSmsEmergencyGrant(grant) || grant.recipientUserId !== recipientId ||
      !grant.ownerUserId || grant.ownerUserId === recipientId ||
      grant.feedSmsConfirmed === false
    ) continue;
    const previous = latest.get(grant.ownerUserId);
    const newer = !previous ||
      (grant.feedLatestSms === true && previous.feedLatestSms !== true) ||
      ((grant.feedLatestSms === true) === (previous.feedLatestSms === true) && (
        instant(grant.feedConfirmedAt ?? grant.createdAt) > instant(previous.feedConfirmedAt ?? previous.createdAt) ||
        (instant(grant.feedConfirmedAt ?? grant.createdAt) === instant(previous.feedConfirmedAt ?? previous.createdAt) && grant.id > previous.id)
      ));
    if (newer) latest.set(grant.ownerUserId, grant);
  }
  return [...latest.values()].filter(grant => grant.feedLatestSms !== false);
}
