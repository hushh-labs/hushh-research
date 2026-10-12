/** Owner-scoped Feed history visibility, shared by full and preview surfaces. */
export function feedClearedThroughStorageKey(ownerId: string): string {
  return `hushh:feed-cleared-through-id:${ownerId}`;
}

export function readFeedClearedThroughId(
  ownerId: string | null,
): string | null {
  if (!ownerId || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(feedClearedThroughStorageKey(ownerId));
  } catch {
    return null;
  }
}
