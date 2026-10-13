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
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PROFILE_MEMORY_SCOPE_IDS, retrieveApprovedMemoryScopes } from "@/lib/pkm/memory-scope-retrieval";
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
  freshnessDate: string;
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
        : !cached.networkVerified || entry?.isStale || cached.freshnessDate !== new Date().toISOString().slice(0, 10)
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

/** Revision-checked view, persisted through the existing encrypted source writer. */
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
    manifestRevision?: number | null;
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
      // Its inventory has per-record revisions; the derived document's own
      // write must not become a new source revision and trigger a save loop.
      sources.push({ domain, contentRevision: domain === "one_living_sources" ? null : snapshot.key.contentRevision,
        manifestRevision: domain === "one_living_sources" ? null : snapshot.manifestRevision });
    } catch {
      sources.push({
        domain,
        contentRevision: null,
        unavailableReason: "could not be read",
      });
    }
  }
  if (!valid()) return stale();
  let builtAt = new Date().toISOString();
  const checkedDate = builtAt.slice(0, 10);
  const livingPrivate = (fullBlob.one_living_sources as { _private?: Record<string, unknown> } | undefined)?._private;
  const records = (livingPrivate?.inventory as { records?: { kind: string; deletedAt: string | null; value: Record<string, unknown> }[] } | undefined)?.records;
  const profile = records?.find(record => record.kind === "profile" && !record.deletedAt)?.value;
  const account = params.account ?? (profile ? {
    displayName: typeof profile.name === "string" ? profile.name : null,
    email: typeof profile.email === "string" ? profile.email : null,
    photoUrl: typeof profile.photo === "string" ? profile.photo : null,
  } : null);
  let document = buildMemoryDocument({
    snapshot: buildPkmMemorySnapshot({ metadata: null, fullBlob }),
    domainData: fullBlob,
    sources,
    audience: "self",
    builtAt,
    account,
  });
  if (document.complete && networkVerified && livingPrivate) {
    const stable = JSON.stringify([document.markdown.replace(builtAt, ""), document.sourceLinks]);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
    const sourceSignature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    if (!valid()) return stale();
    const prior = livingPrivate.memory_document as { signature?: string; document?: MemoryDocument; builtAt?: string } | undefined;
    if (prior?.signature === sourceSignature && prior.document?.complete &&
        prior.document.markdown && Array.isArray(prior.document.sourceLinks) && prior.builtAt) {
      document = prior.document;
      builtAt = prior.builtAt;
    }
    if (prior?.signature !== sourceSignature) {
      const stored = await PkmWriteCoordinator.saveMergedDomain({
        userId: params.userId, domain: "one_living_sources", vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
        confirmation: { authorizationMode: "owner_source_projection", surface: "web", source: "one_living_memory_source_projection" },
        idempotencyScope: `memory_document:${sourceSignature}`,
        beforeEffect: async () => { if (!valid()) throw new Error("Memory sources changed"); },
        build: (context) => {
          if (!valid() || (changes.get(params.userId) ?? 0) !== change) throw new Error("Memory sources changed");
          const current = context.currentDomainData ?? {};
          const privateData = (current._private ?? {}) as Record<string, unknown>;
          // A concurrent source-sync changes the inventory. Retry from its
          // fresh read instead of saving a document over a changed source.
          if (JSON.stringify(privateData.inventory) !== JSON.stringify(livingPrivate.inventory)) throw new Error("Memory inventory changed");
          return { domainData: { ...current, _private: { ...privateData, memory_document: {
            ...((privateData.memory_document ?? {}) as Record<string, unknown>),
            schemaVersion: "source_linked_memory.v1", name: "memory.md", signature: sourceSignature, document, builtAt,
          } } }, summary: { source_projection_complete: true } };
        },
      });
      if (!stored.success) throw new Error("Encrypted memory document could not be stored");
    }
    // Rebuild the stable slices consumed by Request scope from the same
    // encrypted projection after source changes, including birthday changes.
    const requested = Object.keys((prior as { scopeSlices?: Record<string, unknown> } | undefined)?.scopeSlices ?? {});
    const retrieval = await retrieveApprovedMemoryScopes({ userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
      approvedScopes: [...new Set([...PROFILE_MEMORY_SCOPE_IDS, ...requested])], ownerIdentity: account });
    if (!retrieval.complete) {
      document = { ...document, complete: false };
    }
  }
  if (!valid()) return stale();
  CacheService.getInstance().set(
    CACHE_KEY(params.userId),
    { document, builtAt, change, signature, networkVerified, freshnessDate: checkedDate },
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
