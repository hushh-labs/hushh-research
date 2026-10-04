// Like the RIA/PKM epochs: CacheSyncService owns invalidation, while FeedService
// prevents a pre-mutation response from repopulating either Feed projection.
const epochs = new Map<string, number>();
let signedOutEpoch = 0;

export function currentFeedInvalidationEpoch(userId: string): string {
  return `${signedOutEpoch}:${epochs.get(userId) ?? 0}`;
}

export function bumpFeedInvalidationEpoch(userId?: string | null): void {
  if (userId) epochs.set(userId, (epochs.get(userId) ?? 0) + 1);
  else { signedOutEpoch++; epochs.clear(); }
}
