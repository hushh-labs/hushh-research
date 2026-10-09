/** Refresh authority only; credentials and device tokens stay out of this state. */
export let lastKnownSession: { userId: string } | null = null;
let sessionEpoch = 0;
export function getFCMSessionEpoch(): number { return sessionEpoch; }

export function beginFCMSession(userId: string): void {
  if (lastKnownSession?.userId !== userId) {
    sessionEpoch += 1;
    lastKnownSession = { userId };
  }
}

export function clearFCMSession(): void {
  lastKnownSession = null;
  sessionEpoch += 1;
}
