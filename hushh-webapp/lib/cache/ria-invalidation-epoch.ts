// Per-user RIA cache invalidation epoch — a tiny standalone counter shared by
// RiaService (which captures it before a network write-back) and CacheSyncService
// (which bumps it when RIA caches are cleared: persona switch / marketplace /
// delete). Kept in its own dependency-free module so CacheSyncService doesn't
// have to import the full RiaService graph (capacitor/PKM) just to signal an
// invalidation.
//
// The guard prevents a write-after-invalidate race: an in-flight status/persona
// fetch dispatched BEFORE a delete could otherwise repopulate a just-cleared
// (deleted) RIA profile across the memory, device, and native tiers.

const riaInvalidationEpochs = new Map<string, number>();

export function bumpRiaInvalidationEpoch(userId: string): void {
  const normalized = String(userId || "").trim();
  if (!normalized) return;
  riaInvalidationEpochs.set(
    normalized,
    (riaInvalidationEpochs.get(normalized) ?? 0) + 1,
  );
}

export function currentRiaInvalidationEpoch(userId?: string): number {
  const normalized = String(userId || "").trim();
  if (!normalized) return 0;
  return riaInvalidationEpochs.get(normalized) ?? 0;
}
