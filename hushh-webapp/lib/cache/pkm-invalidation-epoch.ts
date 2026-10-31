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
const domainEpochs = new Map<string, number>();

export function bumpPkmInvalidationEpoch(userId: string, domain?: string): void {
  const normalized = String(userId || "").trim();
  if (!normalized) return;
  const key = `${normalized}:${domain ?? "*"}`;
  domainEpochs.set(key, (domainEpochs.get(key) ?? 0) + 1);
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

/** Exact source fences: unrelated projection writes must not invalidate an answer. */
export function currentPkmSourceEpoch(userId: string, domains: readonly string[]): string {
  return ["*", ...new Set(domains)].sort().map(domain => `${domain}:${domainEpochs.get(`${userId}:${domain}`) ?? 0}`).join("|");
}
