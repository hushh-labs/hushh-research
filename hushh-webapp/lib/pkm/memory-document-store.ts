"use client";

import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { blockedManifestPaths, externalizableManifestLeaves } from "@/lib/consent/manifest-exposure";

/** Stable scope slices live beside the Profile document in its existing encrypted projection. */
export interface MemoryScopeSourceRevision {
  domain: string;
  contentRevision: number | null;
  manifestRevision: number | null;
  manifestFingerprint: string | null;
  absent: boolean;
  /** Only the canonical DOB's exposure metadata, never its value. */
  hasCanonicalDob?: boolean;
  readablePaths?: string[];
  blockedPaths?: string[];
}

export interface MemoryScopeSlice {
  /** Older slices predate leaf-level admission and must be rebuilt. */
  admissionVersion?: 2;
  scope: string;
  payload: Record<string, unknown>;
  contentRevision: number | null;
  manifestRevision: number | null;
  sources: MemoryScopeSourceRevision[];
  accountFingerprint: string | null;
  /** Derived age is current only on the UTC date on which it was calculated. */
  freshnessDate: string | null;
  builtAt: string;
}

export interface MemoryDocumentProjection {
  schemaVersion?: string;
  name?: string;
  scopeSlices?: Record<string, MemoryScopeSlice>;
  [key: string]: unknown;
}

export interface MemoryProjectionSession {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A failed read throws. A verified 404 alone means the projection does not exist yet. */
export async function readMemoryDocumentProjection(params: MemoryProjectionSession): Promise<MemoryDocumentProjection | null> {
  const epoch = snapshotVaultSessionEpoch();
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...params, domain: "one_living_sources", force: true });
  if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
  if (!loaded.snapshot) return null;
  if (loaded.snapshot.userId !== params.userId || loaded.snapshot.domain !== "one_living_sources") throw new Error("Memory projection owner changed");
  const projection = record(record(loaded.data)._private).memory_document;
  return projection && typeof projection === "object" && !Array.isArray(projection) ? projection as MemoryDocumentProjection : null;
}

/** Revisions and exposure posture are checked without decrypting source values. */
export async function readMemoryScopeSourceRevisions(params: MemoryProjectionSession & { domains: readonly string[] }): Promise<Record<string, MemoryScopeSourceRevision>> {
  const epoch = snapshotVaultSessionEpoch();
  const entries = await Promise.all([...new Set(params.domains)].sort().map(async domain => {
    const snapshot = await PersonalKnowledgeModelService.getDomainSnapshot({ userId: params.userId, domain, vaultOwnerToken: params.vaultOwnerToken, force: true });
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
    if (!snapshot) return [domain, { domain, contentRevision: null, manifestRevision: null, manifestFingerprint: null, absent: true }] as const;
    if (snapshot.userId !== params.userId || snapshot.domain !== domain) throw new Error("Memory source owner changed");
    if (!snapshot.manifest || !Array.isArray(snapshot.manifest.paths) || !Array.isArray(snapshot.manifest.externalizable_paths)) throw new Error("Memory source manifest unavailable");
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot.manifest)));
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
    const readablePaths = externalizableManifestLeaves(snapshot.manifest).sort();
    const blockedPaths = blockedManifestPaths(snapshot.manifest, readablePaths);
    return [domain, { domain, contentRevision: snapshot.contentRevision, manifestRevision: snapshot.manifestRevision,
      manifestFingerprint: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""), absent: false,
      hasCanonicalDob: domain === "identity" && readablePaths.includes("identity_profile.date_of_birth"), readablePaths, blockedPaths }] as const;
  }));
  return Object.fromEntries(entries);
}

/** Merge through the same client-encrypted writer; preserve inventory, full document and unrelated slices. */
export async function persistMemoryScopeSlices(params: MemoryProjectionSession & {
  slices: readonly MemoryScopeSlice[];
  beforeEffect: () => Promise<void>;
}): Promise<void> {
  if (!params.slices.length) return;
  const epoch = snapshotVaultSessionEpoch();
  const check = async () => {
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
    await params.beforeEffect();
  };
  // Build time is diagnostic, not a source revision, so it never makes a
  // stored slice look changed.
  const content = (slice: unknown) => {
    const { builtAt: _builtAt, ...facts } = record(slice);
    return JSON.stringify(facts);
  };
  // No content-derived receipt: slices can change back to earlier content,
  // and the server refuses a receipt reused at a newer base revision. The build
  // carries the whole fresh domain, so it replaces it: a deep merge kept a field
  // the owner deleted inside a rebuilt slice, and paid answers then reused it.
  // (Inline, so paid retrieval never imports the Live Mirror source model.)
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId, domain: "one_living_sources", vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
    confirmation: { authorizationMode: "owner_source_projection", surface: "web", source: "one_living_memory_source_projection" },
    beforeEffect: check,
    build: async context => {
      await check();
      const current = context.currentDomainData ?? {};
      const privateData = record(current._private);
      const projection = record(privateData.memory_document);
      const slices = { ...record(projection.scopeSlices) };
      const unchanged = params.slices.every(slice => content(slices[slice.scope]) === content(slice));
      for (const slice of params.slices) slices[slice.scope] = slice;
      return { unchanged, domainData: { ...current, _private: { ...privateData, memory_document: {
        ...projection, schemaVersion: "source_linked_memory.v1", name: "memory.md", scopeSlices: slices,
      } } }, mergeDecision: { merge_mode: "replace_domain" }, summary: { source_projection_complete: true } };
    },
  });
  if (!result.success) throw new Error("Encrypted memory scope slices could not be stored");
  if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
}
