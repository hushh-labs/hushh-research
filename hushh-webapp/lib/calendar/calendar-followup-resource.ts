import { CacheService } from "@/lib/services/cache-service";
import { snapshotValidatedAuthSessionOwner, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import type { FollowupList, FollowupStatus } from "@/lib/services/calendar-followups-service";

const PREFIX = "calendar_followups_all_";
let subscribed = false;
type Snapshot = { status: FollowupStatus; list: FollowupList };

/** Session-scoped presentation only; never persisted or used as action authority. */
export function followupResourceKey(owner: string, account: string, revision: number, providerBinding: string) {
  if (!subscribed && typeof window !== "undefined") {
    subscribed = true;
    subscribeAuthSessionGeneration(() => CacheService.getInstance().invalidatePattern(PREFIX));
  }
  const session = snapshotValidatedAuthSessionOwner();
  return session?.userId === owner ? `${PREFIX}${owner}_${JSON.stringify([session.generation, account, revision, providerBinding])}` : "";
}
export function followupSnapshot(key: string) {
  return key ? CacheService.getInstance().peek<Snapshot>(key)?.data ?? null : null;
}
export function saveFollowupSnapshot(key: string, value: Snapshot) {
  if (key) CacheService.getInstance().set(key, value, 60_000);
}
export function clearFollowupSnapshot(key: string) {
  if (key) CacheService.getInstance().invalidate(key);
}

export function invalidateFollowupSnapshots(owner: string) {
  CacheService.getInstance().invalidatePattern(`${PREFIX}${owner}_`);
}
