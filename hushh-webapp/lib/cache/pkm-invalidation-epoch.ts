// Per-user PKM change epoch. CacheSyncService bumps it whenever an encrypted
// domain is stored, cleared, or restored, alongside the `pkm-domain-changed`
// window event. The event only reaches screens that are mounted at that
// moment; the epoch is what a screen mounted later reads to learn that a
// write happened while it was away, so it can force a fresh read instead of
// trusting a write-through metadata patch that still looks fresh.
//
// Dependency-free on purpose, like ria-invalidation-epoch.ts: the hook that
// seeds from it must not pull the CacheSyncService graph into every panel.

const pkmInvalidationEpochs = new Map<string, number>();

export function bumpPkmInvalidationEpoch(userId: string): void {
  const normalized = String(userId || "").trim();
  if (!normalized) return;
  pkmInvalidationEpochs.set(
    normalized,
    (pkmInvalidationEpochs.get(normalized) ?? 0) + 1,
  );
}

export function currentPkmInvalidationEpoch(userId?: string | null): number {
  const normalized = String(userId || "").trim();
  if (!normalized) return 0;
  return pkmInvalidationEpochs.get(normalized) ?? 0;
}
