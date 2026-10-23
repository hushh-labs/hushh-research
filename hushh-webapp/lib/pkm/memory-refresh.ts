"use client";

import { CacheService, CACHE_TTL, type CacheSnapshot } from "@/lib/services/cache-service";
import {
  buildMemoryDocument,
  type MemoryAccountIdentity,
  type MemoryDocument,
} from "@/lib/pkm/memory-document";
import { buildPkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";
import { buildOwnerLivingFactIndex } from "@/lib/pkm/living-source-fact-index";
import type {
  LivingJournalPending,
  LivingSourceHealth,
  LivingSourceHistory,
  LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import { getLivingSourceSessionVerification } from "@/lib/pkm/living-source-session-verification";
import { readLabelledSoulFacts, soulFactKey } from "@/lib/pkm/soul-labelled-facts";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
import { PROFILE_MEMORY_SCOPE_IDS, retrieveApprovedMemoryScopes } from "@/lib/pkm/memory-scope-retrieval";
import type { LiveMirrorProjection, LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import {
  applyLiveMirrorReadTime,
  buildLiveMirrorProjection,
  liveMirrorHasExpiredSource,
} from "@/lib/pkm/live-mirror-projection";
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
  /** Owner-only Live Mirror; RAM only, dropped with this entry. */
  projection: LiveMirrorProjection | null;
};
const peekCached = (userId: string) => CacheService.getInstance().peek<Cached>(CACHE_KEY(userId));

/** Observe this owner's existing RAM projection; subscribing never refreshes or writes it. */
export function subscribeLiveMirror(userId: string, listener: () => void): () => void {
  const key = CACHE_KEY(userId);
  return CacheService.getInstance().subscribe(event => {
    if (event.type === "clear" || (event.type === "set" ? event.key === key : event.keys.includes(key))) listener();
  });
}

/**
 * Newer source verifications from this owner's unlocked session. An unchanged
 * sync re-verified its sources without a write or a rebuild, so its time is
 * applied when the mirror is read. Another owner or vault epoch adds nothing.
 */
function withSessionVerification(userId: string, projection: LiveMirrorProjection): LiveMirrorProjection {
  if (projection.ownerId !== userId || projection.vaultEpoch !== snapshotVaultSessionEpoch()) return projection;
  const session = getLivingSourceSessionVerification(userId, projection.vaultEpoch);
  const newer = (kind: keyof typeof session, at: string | null): string | null => {
    const verified = session[kind];
    return verified && (at === null || Date.parse(verified) > Date.parse(at)) ? verified : null;
  };
  const refreshed = new Map<string, string>();
  const sources = projection.sources.map((source) => {
    if (source.group !== "living" || !source.kind || source.state === "unavailable") return source;
    const verifiedAt = newer(source.kind, source.verifiedAt);
    if (!verifiedAt) return source;
    refreshed.set(source.kind, verifiedAt);
    return { ...source, verifiedAt };
  });
  if (!refreshed.size) return projection;
  const facts = projection.facts.map((fact) => {
    const verifiedAt = refreshed.get(fact.kind);
    return verifiedAt && newer(fact.kind, fact.verifiedAt) ? { ...fact, verifiedAt } : fact;
  });
  // A source claim's provenance moves with its source; an owner-authored one has none.
  const conflicts = projection.conflicts?.map((conflict) => ({
    ...conflict,
    claims: conflict.claims.map((claim) => {
      const verifiedAt = claim.source !== "soul" && refreshed.has(claim.source) ? newer(claim.source, claim.verifiedAt) : null;
      return verifiedAt ? { ...claim, verifiedAt } : claim;
    }),
  }));
  return { ...projection, sources, facts, ...(conflicts ? { conflicts } : {}) };
}

/**
 * The owner-authored display and preferred names that differ from the
 * verified profile name, found by the rules buildMemoryDocument uses for its
 * name conflict (same labels, deletions and comparison), so the mirror shows
 * every side of the conflict the document reports. Empty when none differs
 * or the Soul was not read.
 */
function soulNameClaims(soul: unknown, verifiedName: string | null): string[] {
  const canonical = verifiedName?.trim();
  if (!canonical || !soul || typeof soul !== "object") return [];
  const { markdown, _deleted_fact_labels: deletedLabels } = soul as { markdown?: unknown; _deleted_fact_labels?: unknown };
  const deleted = new Set((Array.isArray(deletedLabels) ? deletedLabels : [])
    .filter((label): label is string => typeof label === "string").map(soulFactKey));
  const labelled = readLabelledSoulFacts(typeof markdown === "string" ? markdown : null);
  const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const seen = new Set([normalized(canonical)]);
  const names: string[] = [];
  for (const label of ["display name", "preferred name"]) {
    const fact = labelled.get(label);
    if (!fact || deleted.has(soulFactKey(fact.label)) || seen.has(normalized(fact.value))) continue;
    seen.add(normalized(fact.value));
    names.push(fact.value);
  }
  return names;
}

/** Document-level status, without the per-source verification-age check. */
function documentStatus(userId: string, entry: CacheSnapshot<Cached>, now: number): MemoryRefreshStatus {
  const cached = entry.data;
  return !cached.document.complete
    ? "refresh_failed"
    : cached.change !== (changes.get(userId) ?? 0)
      ? "refresh_pending"
      : !cached.networkVerified || Math.max(0, now - entry.timestamp) > entry.ttl ||
          cached.freshnessDate !== new Date(now).toISOString().slice(0, 10)
        ? "stale"
        : "current";
}

/** Owner-filtered, deduplicated freshness subscription; never holds a key. */
export function watchMemoryFreshness(userId: string): () => void {
  let watch = watches.get(userId);
  if (!watch) {
    watch = {
      users: 0,
      stop: subscribeToPkmDomainChanges((detail) => {
        if (detail.userId !== userId) return;
        // Derived projection writes cannot invalidate their authoritative sources.
        if (detail.domain === "one_living_sources" && detail.operation === "stored") return;
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
  const entry = peekCached(userId);
  if (!entry?.data) return stale();
  const now = Date.now();
  const status = documentStatus(userId, entry, now);
  const { document, builtAt, projection } = entry.data;
  // A living source past its verification window is never current, even
  // while the session cache entry is fresh.
  return {
    document,
    builtAt,
    status: status === "current" && projection &&
      liveMirrorHasExpiredSource(withSessionVerification(userId, projection), now) ? "stale" : status,
  };
}
/**
 * The owner's shared Live Mirror with read-time states applied, or null before
 * a build exists. "Current" is re-derived on every read, never cached.
 */
export function peekLiveMirror(userId: string, now: number = Date.now()): LiveMirrorView | null {
  const entry = peekCached(userId);
  const projection = entry?.data.projection;
  if (!entry || !projection || projection.ownerId !== userId) return null;
  return applyLiveMirrorReadTime(withSessionVerification(userId, projection), now, documentStatus(userId, entry, now));
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
  const existing = peekCached(params.userId);
  // Verification age alone is not a reason to re-read every domain: only a
  // source sync can renew it, and each sync wake already marks this pending.
  if (
    !params.force &&
    existing?.data.signature === signature &&
    documentStatus(params.userId, existing, Date.now()) === "current"
  )
    return peekMemoryView(params.userId);
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
  // Live Mirror inputs, kept even when the inventory is incomplete. They never
  // enter fullBlob, the persisted document or paid scope retrieval.
  let mirrorInputs: Record<string, unknown> | null = null;
  let mirrorReadFailed = false;
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
        if (domain === "one_living_sources") mirrorReadFailed = true;
        sources.push({
          domain,
          contentRevision: null,
          unavailableReason: "could not be read",
        });
        continue;
      }
      if (domain === "one_living_sources") {
        const mirrorPrivate = snapshot.data._private;
        mirrorInputs = mirrorPrivate && typeof mirrorPrivate === "object" && !Array.isArray(mirrorPrivate)
          ? mirrorPrivate as Record<string, unknown> : null;
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
      if (domain === "one_living_sources") mirrorReadFailed = true;
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
  const inventory = livingPrivate?.inventory as LivingSourceInventory | undefined;
  const factIndex = inventory && Array.isArray(inventory.records) && Array.isArray(inventory.unavailable)
    ? buildOwnerLivingFactIndex({ expectedOwnerId: params.userId, inventory, now: builtAt })
    : null;
  const profileValue = (predicate: string): string | null => {
    const nodes = factIndex?.byPredicate.get(predicate);
    return nodes?.length === 1 && nodes[0]?.status === "verified" &&
      typeof nodes[0].value === "string" ? nodes[0].value : null;
  };
  const profile = factIndex?.byPredicate.get("profile.__record")?.some(node => node.status === "verified");
  const account = params.account ?? (profile ? {
    displayName: profileValue("profile.name"),
    email: profileValue("profile.email"),
    photoUrl: profileValue("profile.photo"),
  } : null);
  const verifiedProfileName = profileValue("profile.name");
  let document = buildMemoryDocument({
    snapshot: buildPkmMemorySnapshot({ metadata: null, fullBlob }),
    ownerUserId: params.userId,
    domainData: fullBlob,
    sources,
    audience: "self",
    builtAt,
    account,
    verifiedProfileName,
  });
  if (document.complete && networkVerified && livingPrivate && !shouldSkipReviewerBackgroundWritesForAutomation()) {
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
      let superseded = false;
      const cancelSuperseded = (message: string): never => {
        superseded = true;
        // Inventory changes can precede their event. Mark an older cached
        // document pending, while leaving a newer generation's cache alone.
        if (valid() && (changes.get(params.userId) ?? 0) === change) {
          markMemoryRefreshPending(params.userId);
        }
        throw new DOMException(message, "AbortError");
      };
      const assertCurrentSources = () => {
        if (!valid() || shouldSkipReviewerBackgroundWritesForAutomation() || (changes.get(params.userId) ?? 0) !== change) {
          cancelSuperseded("Memory sources changed");
        }
      };
      const stored = await PkmWriteCoordinator.saveMergedDomain({
        userId: params.userId, domain: "one_living_sources", vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
        confirmation: { authorizationMode: "owner_source_projection", surface: "web", source: "one_living_memory_source_projection" },
        idempotencyScope: `memory_document:${sourceSignature}`,
        beforeEffect: async () => { assertCurrentSources(); },
        build: (context) => {
          assertCurrentSources();
          const current = context.currentDomainData ?? {};
          const privateData = (current._private ?? {}) as Record<string, unknown>;
          // A concurrent source-sync changes the inventory. Retry from its
          // fresh read instead of saving a document over a changed source.
          if (JSON.stringify(privateData.inventory) !== JSON.stringify(livingPrivate.inventory)) cancelSuperseded("Memory inventory changed");
          return { unchanged: (privateData.memory_document as { signature?: string } | undefined)?.signature === sourceSignature, domainData: { ...current, _private: { ...privateData, memory_document: {
            ...((privateData.memory_document ?? {}) as Record<string, unknown>),
            schemaVersion: "source_linked_memory.v1", name: "memory.md", signature: sourceSignature, document, builtAt,
          } } }, summary: { source_projection_complete: true } };
        },
      });
      if (superseded || !valid()) return stale();
      if (!stored.success) throw new Error("Encrypted memory document could not be stored");
    }
    // Rebuild the stable slices consumed by Request scope from the same
    // encrypted projection after source changes, including birthday changes.
    const requested = Object.keys((prior as { scopeSlices?: Record<string, unknown> } | undefined)?.scopeSlices ?? {});
    const retrieval = await retrieveApprovedMemoryScopes({ userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
      approvedScopes: [...new Set([...PROFILE_MEMORY_SCOPE_IDS, ...requested])], ownerIdentity: account,
      assertActive: () => { if (!valid() || shouldSkipReviewerBackgroundWritesForAutomation()) throw new DOMException("Background memory refresh cancelled", "AbortError"); } });
    if (!retrieval.complete) {
      document = { ...document, complete: false };
    }
  }
  if (!valid()) return stale();
  let projection: LiveMirrorProjection | null = null;
  try {
    projection = buildLiveMirrorProjection({
      ownerId: params.userId,
      vaultEpoch: epoch,
      now: new Date().toISOString(),
      inventory: (mirrorInputs?.inventory ?? null) as LivingSourceInventory | null,
      history: (mirrorInputs?.observed_history ?? null) as LivingSourceHistory | null,
      pending: (mirrorInputs?.journal_pending ?? null) as LivingJournalPending | null,
      health: (mirrorInputs?.source_health ?? null) as LivingSourceHealth | null,
      document,
      sessionVerifiedAt: getLivingSourceSessionVerification(params.userId, epoch),
      nameConflict: document.freshness.some(entry => entry.domain === "one_memory" && entry.status === "conflicted"),
      // The sides of that conflict, read from the same Soul and verified name
      // the document compared, so the mirror shows them instead of choosing.
      nameClaims: { soul: soulNameClaims(fullBlob.one_memory, verifiedProfileName), profile: verifiedProfileName },
      inventoryReadFailed: mirrorReadFailed,
      excludeSavedDomains: ["one_living_sources"],
    });
  } catch {
    // The mirror stays "Checking sources"; the document itself is unaffected.
    projection = null;
  }
  CacheService.getInstance().set(
    CACHE_KEY(params.userId),
    { document, builtAt, change, signature, networkVerified, freshnessDate: checkedDate, projection },
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
