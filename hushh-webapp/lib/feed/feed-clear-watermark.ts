/** Owner-scoped Feed history visibility, shared by full and preview surfaces. */
export function feedClearedThroughStorageKey(ownerId: string): string {
  return `hushh:feed-cleared-through-id:${ownerId}`;
}

/** An older release's device-only Clear time; it cannot be copied, only retired. */
export function feedLegacyClearedAtStorageKey(ownerId: string): string {
  return `hushh:feed-cleared-at:${ownerId}`;
}

/** An older release's device-only SOS clears, kept until copied to the server. */
export function feedDeviceOnlySosClearStorageKey(ownerId: string): string {
  return `hushh:feed-sms-dismissed:${ownerId}`;
}

/** The Feed sound choice for one account on this device. */
export function feedSoundStorageKey(ownerId: string): string {
  return `hushh:feed-sound-enabled:${ownerId}`;
}

/**
 * Remove every Feed key this device keeps for one account. Only for account
 * delete or reset: sign-out keeps the sound choice, and device-only clears
 * stay until they are copied to the server.
 */
export function forgetFeedDeviceState(ownerId: string): void {
  if (!ownerId || typeof window === "undefined") return;
  for (const key of [
    feedClearedThroughStorageKey(ownerId),
    feedLegacyClearedAtStorageKey(ownerId),
    feedDeviceOnlySosClearStorageKey(ownerId),
    feedSoundStorageKey(ownerId),
  ]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage disabled: nothing is kept to remove.
    }
  }
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
