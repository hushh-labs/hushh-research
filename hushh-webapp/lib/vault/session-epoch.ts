/** Browser-runtime credential generation; never contains key/token material or
 * authority. Token renewal also advances it, so it is not an unlock-lifetime
 * identity. Keep old-credential response fencing distinct from UI continuity. */
let vaultSessionEpoch = 0;
const vaultSessionEpochListeners = new Set<() => void>();

export function snapshotVaultSessionEpoch(): number {
  return typeof window === "undefined" ? 0 : vaultSessionEpoch;
}

export function advanceVaultSessionEpoch(): void {
  if (typeof window === "undefined") return;
  vaultSessionEpoch += 1;
  for (const listener of vaultSessionEpochListeners) listener();
}

export function isVaultSessionEpochCurrent(epoch: number): boolean {
  return snapshotVaultSessionEpoch() === epoch;
}

/** Subscribe to lock/unlock/key rotation and credential renewal without key material. */
export function subscribeVaultSessionEpoch(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  vaultSessionEpochListeners.add(listener);
  return () => vaultSessionEpochListeners.delete(listener);
}
