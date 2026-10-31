/** In-memory stale-read fence, not connection or credential authority. */
const revisions = new Map<string, number>();
export function googleConnectionEpoch(userId: string): number {
  return revisions.get(userId) ?? 0;
}
export function advanceGoogleConnectionEpoch(userId: string): void {
  revisions.set(userId, googleConnectionEpoch(userId) + 1);
}
