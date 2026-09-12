/** Browser-runtime generation only; never contains key/token material or authority. */
let vaultSessionEpoch = 0;

export function snapshotVaultSessionEpoch(): number {
  return typeof window === "undefined" ? 0 : vaultSessionEpoch;
}

export function advanceVaultSessionEpoch(): void {
  if (typeof window !== "undefined") vaultSessionEpoch += 1;
}

export function isVaultSessionEpochCurrent(epoch: number): boolean {
  return snapshotVaultSessionEpoch() === epoch;
}
