"use client";

import { CacheService, CACHE_TTL } from "@/lib/services/cache-service";
import {
  buildMemoryDocument,
  type MemoryAccountIdentity,
  type MemoryDocument,
} from "@/lib/pkm/memory-document";
import { buildPkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export type MemoryRefreshStatus =
  "current" | "refresh_pending" | "refresh_failed" | "stale";
export interface MemoryView {
  document: MemoryDocument | null;
  status: MemoryRefreshStatus;
  builtAt: string | null;
}
const CACHE_KEY = (userId: string) => `pkm_memory_document_${userId}`;
const changes = new Map<string, number>();
const generations = new Map<string, number>();
const watches = new Map<string, { stop: () => void; users: number }>();
const stale = (): MemoryView => ({
  document: null,
  status: "stale",
  builtAt: null,
});
type Cached = {
  document: MemoryDocument;
  builtAt: string;
  change: number;
  signature: string;
  networkVerified: boolean;
};

/** Owner-filtered, deduplicated freshness subscription; never holds a key. */
export function watchMemoryFreshness(userId: string): () => void {
  let watch = watches.get(userId);
  if (!watch) {
    watch = {
      users: 0,
      stop: subscribeToPkmDomainChanges((detail) => {
        if (detail.userId !== userId) return;
        changes.set(userId, (changes.get(userId) ?? 0) + 1);
      }),
    };
    watches.set(userId, watch);
  }
  watch.users += 1;
  return () => {
    if (!watch || --watch.users > 0) return;
    watch.stop();
    watches.delete(userId);
  };
}

export function markMemoryRefreshPending(userId: string): void {
  changes.set(userId, (changes.get(userId) ?? 0) + 1);
}

export function peekMemoryView(userId: string): MemoryView {
  const entry = CacheService.getInstance().peek<Cached>(CACHE_KEY(userId));
  const cached = entry?.data;
  if (!cached) return stale();
  return {
    document: cached.document,
    builtAt: cached.builtAt,
    status: !cached.document.complete
      ? "refresh_failed"
      : cached.change !== (changes.get(userId) ?? 0)
        ? "refresh_pending"
        : !cached.networkVerified || entry?.isStale
          ? "stale"
          : "current",
  };
}
export interface RefreshMemoryParams {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  domains: readonly string[];
  account?: MemoryAccountIdentity | null;
  force?: boolean;
}

/** Reproducible session-only view of authoritative encrypted readback. */
export async function refreshMemoryDocument(
  params: RefreshMemoryParams,
): Promise<MemoryView> {
  if (!params.vaultKey || !params.vaultOwnerToken) return stale();
  const signature = JSON.stringify([
    [...new Set(params.domains)].sort(),
    params.account ?? null,
  ]);
  const cached = CacheService.getInstance().peek<Cached>(
    CACHE_KEY(params.userId),
  )?.data;
  const existing = peekMemoryView(params.userId);
  if (
    !params.force &&
    existing.status === "current" &&
    cached?.signature === signature
  )
    return existing;
  const epoch = snapshotVaultSessionEpoch();
  const generation = (generations.get(params.userId) ?? 0) + 1;
  generations.set(params.userId, generation);
  const change = changes.get(params.userId) ?? 0;
  const valid = () =>
    isVaultSessionEpochCurrent(epoch) &&
    generations.get(params.userId) === generation;
  const sources: {
    domain: string;
    contentRevision: number | null;
    unavailableReason?: string;
  }[] = [];
  const fullBlob: Record<string, unknown> = {};
  let networkVerified = true;
  for (const domain of [...new Set(params.domains)].sort()) {
    if (!valid()) return stale();
    try {
      const read = {
        userId: params.userId,
        domain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      };
      // SWR may return yesterday's secure cache while a read is in flight.
      // Await authoritative refresh before calling this document current.
      let snapshot = await PkmDomainResourceService.refresh(read);
      if (!snapshot) {
        snapshot = await PkmDomainResourceService.getStaleFirst(read);
        networkVerified = false;
      }
      if (!snapshot?.data) {
        sources.push({
          domain,
          contentRevision: null,
          unavailableReason: "could not be read",
        });
        continue;
      }
      const inventory = (
        snapshot.data._private as
          { inventory?: { complete?: boolean } } | undefined
      )?.inventory;
      if (domain === "one_living_sources" && inventory?.complete !== true) {
        sources.push({
          domain,
          contentRevision: snapshot.key.contentRevision,
          unavailableReason: "source inventory incomplete",
        });
        continue;
      }
      fullBlob[domain] = snapshot.data;
      sources.push({ domain, contentRevision: snapshot.key.contentRevision });
    } catch {
      sources.push({
        domain,
        contentRevision: null,
        unavailableReason: "could not be read",
      });
    }
  }
  if (!valid()) return stale();
  const builtAt = new Date().toISOString();
  const document = buildMemoryDocument({
    snapshot: buildPkmMemorySnapshot({ metadata: null, fullBlob }),
    domainData: fullBlob,
    sources,
    audience: "self",
    builtAt,
    account: params.account ?? null,
  });
  CacheService.getInstance().set(
    CACHE_KEY(params.userId),
    { document, builtAt, change, signature, networkVerified },
    CACHE_TTL.SESSION,
  );
  // Preserve the captured event revision: edits arriving during readback stay pending.
  return peekMemoryView(params.userId);
}

export function clearMemoryDocument(userId: string): void {
  generations.set(userId, (generations.get(userId) ?? 0) + 1);
  CacheService.getInstance().invalidate(CACHE_KEY(userId));
  changes.delete(userId);
}
