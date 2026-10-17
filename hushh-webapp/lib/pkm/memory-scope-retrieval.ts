"use client";

import { buildConsentExportForScope, createConsentExportReadSession } from "@/lib/consent/export-builder";
import { settleWithConcurrency } from "@/lib/consent/bounded-concurrency";
import { currentPkmSourceEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { answerProfilePhotoUrl, isAnswerProfilePhotoScope } from "@/lib/answers/answer-profile-photo";
import { approvedScopesBackedBySoul, isOwnProfileNameScope, projectApprovedSoulFacts, SCOPE_PATH_TO_LABEL } from "@/lib/pkm/identity-memory-facts";
import { loadMarkdownMemory, peekMarkdownMemory } from "@/lib/pkm/markdown-memory";
import { ageFromDateOfBirth, readLabelledSoulFacts, soulFactKey } from "@/lib/pkm/soul-labelled-facts";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { persistMemoryScopeSlices, readMemoryDocumentProjection, readMemoryScopeSourceRevisions,
  type MemoryProjectionSession, type MemoryScopeSlice, type MemoryScopeSourceRevision } from "@/lib/pkm/memory-document-store";

export interface ApprovedMemoryProjection {
  scope: string;
  payload: Record<string, unknown>;
  contentRevision: number | null;
}
export interface ApprovedMemoryRetrieval {
  projections: ApprovedMemoryProjection[];
  unavailableScopes: string[];
  sourceManifestRevisions: Record<string, number | null>;
  builtAt: string;
  complete: boolean;
  /** Revalidate immediately before staging; never send this owner-side guard to Gemini. */
  assertCurrent(): Promise<void>;
  sourceFreshness: Record<string, {
    sources: { domain: string; contentRevision: number | null; manifestRevision: number | null; absent: boolean }[];
    derivedOn: string | null;
    builtAt: string;
  }>;
}
export interface ApprovedMemoryRetrievalParams extends MemoryProjectionSession {
  approvedScopes: readonly string[];
  ownerIdentity?: { displayName?: string | null; email?: string | null; photoUrl?: string | null } | null;
  /** Fresh canonical account read used only when account facts contribute to a staged answer. */
  readOwnerIdentity?: () => Promise<{ displayName?: string | null; photoUrl?: string | null } | null>;
  now?: Date;
  assertActive?: () => void;
  onRefreshTiming?: (started: number) => void;
}

const CANONICAL_DOB = "attr.identity.identity_profile.date_of_birth";
const AGE_PATHS = ["identity_profile.declared_age", "profile.age"];
export const PROFILE_MEMORY_SCOPE_IDS: readonly string[] = [
  ...SCOPE_PATH_TO_LABEL.map(([path]) => `attr.${path.startsWith("profile.") ? "professional" : "identity"}.${path}`),
  "attr.identity.identity_profile.declared_age", "attr.identity.identity_profile.profile_photo_url",
];
function covers(scope: string, domain: string, path: string): boolean {
  return scope === `attr.${domain}.${path}` || scope === `attr.${domain}.${path.split(".").slice(0, -1).join(".")}.*`;
}
function agePaths(scope: string): string[] {
  return scope === "attr.professional.profile.age" || scope === "attr.professional.profile.*" ? ["profile.age"] : AGE_PATHS.filter(path => covers(scope, "identity", path));
}
function isAgeScope(scope: string): boolean { return agePaths(scope).length > 0; }
function requiresAgeDerivation(scope: string, sources: Record<string, MemoryScopeSourceRevision>): boolean {
  return isAgeScope(scope) && (scope !== "attr.professional.profile.*" || sources.professional?.readablePaths?.includes("profile.age") === true);
}
function isLegacySexScope(scope: string): boolean {
  return covers(scope, "identity", "profile.sex") || scope === "attr.professional.profile.sex" || scope === "attr.professional.profile.*";
}
function usesSoul(scope: string): boolean {
  return approvedScopesBackedBySoul([scope]).length > 0 || isOwnProfileNameScope(scope) || isAgeScope(scope) || isLegacySexScope(scope);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === "object") return Object.entries(record(value)).some(([key, item]) => !key.startsWith("__") && hasValue(item));
  return true;
}
function getPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split(".")) current = record(current)[part];
  return current;
}
function setPath(payload: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let branch = payload;
  for (const segment of segments.slice(0, -1)) branch = (branch[segment] = record(branch[segment])) as Record<string, unknown>;
  if (value === undefined) delete branch[segments.at(-1)!];
  else branch[segments.at(-1)!] = value;
}
function scopePath(scope: string): string { return scope.split(".").slice(2).join("."); }
function scopeDomain(scope: string): string { return scope.split(".")[1] ?? ""; }
function accountFingerprint(scope: string, identity: ApprovedMemoryRetrievalParams["ownerIdentity"]): string | null {
  if (isOwnProfileNameScope(scope)) return JSON.stringify([identity?.displayName?.trim() ?? null]);
  if (isAnswerProfilePhotoScope(scope)) return JSON.stringify([answerProfilePhotoUrl(identity?.photoUrl)]);
  return null;
}
function dependencies(scope: string, sources?: Record<string, MemoryScopeSourceRevision>): string[] {
  const derivedAge = scope === "attr.professional.profile.*" ? Boolean(sources && requiresAgeDerivation(scope, sources)) : isAgeScope(scope);
  return [...new Set([scopeDomain(scope), ...(usesSoul(scope) ? ["one_memory"] : []), ...(derivedAge ? ["identity"] : [])])];
}
function sameSources(before: readonly MemoryScopeSourceRevision[], after: readonly MemoryScopeSourceRevision[]): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}
function hasStructuredCounterpart(scope: string, source: MemoryScopeSourceRevision): boolean {
  const path = scopePath(scope).replace(/\.\*$/, "");
  return (source.readablePaths ?? []).some(leaf => leaf === path || leaf.startsWith(`${path}.`));
}
function pathBlocked(path: string, source: MemoryScopeSourceRevision): boolean {
  return (source.blockedPaths ?? []).some(blocked => path === blocked || path.startsWith(`${blocked}.`));
}
function scopeBlocked(scope: string, source: MemoryScopeSourceRevision): boolean {
  return pathBlocked(scopePath(scope).replace(/\.\*$/, ""), source);
}
function freshnessMetadata(slices: ReadonlyMap<string, MemoryScopeSlice>): ApprovedMemoryRetrieval["sourceFreshness"] {
  return Object.fromEntries([...slices].map(([scope, slice]) => {
    const absentWildcardAge = scope === "attr.professional.profile.*" && !hasValue(getPath(slice.payload, "profile.age"));
    return [scope, {
      sources: slice.sources.filter(source => !absentWildcardAge || source.domain !== "identity")
        .map(({ domain, contentRevision, manifestRevision, absent }) => ({ domain, contentRevision, manifestRevision, absent })),
      derivedOn: absentWildcardAge ? null : slice.freshnessDate, builtAt: slice.builtAt,
    }];
  }));
}

/**
 * Read exact stable scopes from the shared encrypted memory.md projection.
 * Revision/manifest checks precede reuse; missing/stale slices are rebuilt
 * from authoritative PKM before an empty result can mean "not recorded".
 */
export async function retrieveApprovedMemoryScopes(params: ApprovedMemoryRetrievalParams): Promise<ApprovedMemoryRetrieval> {
  const now = params.now ?? new Date();
  const builtAt = now.toISOString();
  const date = builtAt.slice(0, 10);
  const scopes = [...new Set(params.approvedScopes)];
  const unavailable = (failed: readonly string[] = scopes): ApprovedMemoryRetrieval => ({ projections: [], unavailableScopes: [...failed], sourceManifestRevisions: {}, builtAt, complete: false, sourceFreshness: {}, assertCurrent: async () => { throw new Error("Memory sources unavailable"); } });
  if (!params.vaultKey || !params.vaultOwnerToken || scopes.some(scope => !/^attr\.[a-z0-9_]+(?:\.[a-z0-9_*]+)+$/.test(scope))) return unavailable();
  const epoch = snapshotVaultSessionEpoch();
  const domains = [...new Set(scopes.flatMap(scope => dependencies(scope)))].sort();
  const fencedDomains = scopes.includes("attr.professional.profile.*") ? [...domains, "identity"] : domains;
  const sourceEpoch = currentPkmSourceEpoch(params.userId, fencedDomains);
  const valid = () => {
    params.assertActive?.();
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
    if (currentPkmSourceEpoch(params.userId, fencedDomains) !== sourceEpoch) throw new Error("Memory sources changed during retrieval");
    if (!params.now && scopes.some(isAgeScope) && new Date().toISOString().slice(0, 10) !== date) throw new Error("Age changed during retrieval");
  };
  try {
    const accountFingerprints = new Map(await Promise.all(scopes.map(async scope => {
      const value = accountFingerprint(scope, params.ownerIdentity);
      if (value === null) return [scope, null] as const;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [scope, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")] as const;
    })));
    valid();
    const [stored, sources] = await Promise.all([
      readMemoryDocumentProjection(params), readMemoryScopeSourceRevisions({ ...params, domains }),
    ]);
    valid();
    // A professional parent is ordinarily an employment group. Derive age
    // only if its eligible source already contains that legacy age address;
    // approving employment must not add unrelated personal identity facts.
    if (scopes.includes("attr.professional.profile.*") && sources.professional?.readablePaths?.includes("profile.age") && !sources.identity) {
      Object.assign(sources, await readMemoryScopeSourceRevisions({ ...params, domains: ["identity"] }));
      domains.push("identity");
      valid();
    }
    const pending = scopes.some(usesSoul) ? peekMarkdownMemory(params.userId)?.syncStatus : undefined;
    if (pending && pending !== "synced") return unavailable(scopes.filter(usesSoul));
    const slices = new Map<string, MemoryScopeSlice>();
    const guardedResult = (complete: boolean): ApprovedMemoryRetrieval => {
      // The encrypted projection's own save bumps the PKM epoch. Capture the
      // epoch only after its final source verification, then retain the exact
      // source snapshots for remote-change checks after asynchronous model work.
      const verifiedEpoch = currentPkmSourceEpoch(params.userId, domains);
      const captured = new Map([...slices].map(([scope, slice]) => [scope, structuredClone(slice)]));
      const checkSession = () => {
        if (!complete || !isVaultSessionEpochCurrent(epoch) || currentPkmSourceEpoch(params.userId, domains) !== verifiedEpoch)
          throw new Error("Memory sources changed before staging");
        if (!params.now && scopes.some(isAgeScope) && new Date().toISOString().slice(0, 10) !== date)
          throw new Error("Age changed before staging");
        const localStatus = scopes.some(usesSoul) ? peekMarkdownMemory(params.userId)?.syncStatus : undefined;
        if (localStatus && localStatus !== "synced") throw new Error("Private memory readback pending");
      };
      return {
        projections: scopes.flatMap(scope => { const slice = captured.get(scope); return slice ? [{ scope, payload: structuredClone(slice.payload), contentRevision: slice.contentRevision }] : []; }),
        unavailableScopes: scopes.filter(scope => !captured.has(scope)),
        sourceManifestRevisions: Object.fromEntries([...captured].map(([scope, slice]) => [scope, slice.manifestRevision])),
        builtAt, complete, sourceFreshness: freshnessMetadata(captured),
        assertCurrent: async () => {
          checkSession();
          const current = await readMemoryScopeSourceRevisions({ ...params, domains });
          checkSession();
          if ([...captured].some(([scope, slice]) => !sameSources(slice.sources, dependencies(scope, current).map(domain => current[domain]!))))
            throw new Error("Authoritative memory changed before staging");
          const accountScopes = [...captured].filter(([scope, slice]) => isAnswerProfilePhotoScope(scope) ||
            isOwnProfileNameScope(scope) && slice.contentRevision === null && hasValue(slice.payload));
          if (accountScopes.length) {
            if (!params.readOwnerIdentity) throw new Error("Canonical account freshness unavailable");
            const identity = await params.readOwnerIdentity();
            checkSession();
            if (!identity) throw new Error("Canonical account freshness unavailable");
            for (const [scope, slice] of accountScopes) {
              const value = accountFingerprint(scope, identity);
              if (value === null) throw new Error("Canonical account freshness unavailable");
              const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
              checkSession();
              const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
              if (fingerprint !== slice.accountFingerprint) throw new Error("Account identity changed before staging");
            }
          }
          checkSession();
        },
      };
    };
    const rebuild: string[] = [];
    for (const scope of scopes) {
      const slice = stored?.scopeSlices?.[scope];
      const current = dependencies(scope, sources).map(domain => sources[domain]!);
      if (!scopeBlocked(scope, sources[scopeDomain(scope)]!) && slice?.admissionVersion === 2 && slice.scope === scope && record(slice.payload) === slice.payload && sameSources(slice.sources, current) &&
          slice.accountFingerprint === accountFingerprints.get(scope) &&
          slice.freshnessDate === (requiresAgeDerivation(scope, sources) ? date : null)) slices.set(scope, slice);
      else rebuild.push(scope);
    }
    if (rebuild.length) {
      const refreshStarted = performance.now();
      const includeDob = rebuild.some(scope => requiresAgeDerivation(scope, sources)) && sources.identity?.hasCanonicalDob === true;
      const materializedScopes = rebuild.filter(scope => hasStructuredCounterpart(scope, sources[scopeDomain(scope)]!) && !isAnswerProfilePhotoScope(scope));
      const sessionScopes = [...new Set([...materializedScopes, ...(includeDob ? [CANONICAL_DOB] : [])])];
      const readSession = createConsentExportReadSession({ ...params, scopes: sessionScopes });
      const policyFailed = new Set(rebuild.filter(scope => scopeBlocked(scope, sources[scopeDomain(scope)]!)));
      const failed = new Set<string>(policyFailed);
      const originals = new Map<string, { payload: Record<string, unknown>; contentRevision: number | null; manifestRevision: number | null }>();
      await settleWithConcurrency(rebuild, 4, async scope => {
        if (policyFailed.has(scope)) return;
        try {
          const result = await buildConsentExportForScope({ ...params, scope, readSession: sessionScopes.includes(scope) ? readSession : createConsentExportReadSession({ ...params, scopes: [scope] }) });
          valid();
          const source = sources[scopeDomain(scope)]!;
          if (result.sourceContentRevision !== undefined && result.sourceContentRevision !== source.contentRevision ||
              result.sourceManifestRevision !== undefined && result.sourceManifestRevision !== source.manifestRevision ||
              result.sourceContentRevision === undefined && !source.absent && hasStructuredCounterpart(scope, source)) throw new Error("Memory revision changed during rebuild");
          originals.set(scope, { payload: record(result.payload), contentRevision: result.sourceContentRevision ?? null, manifestRevision: result.sourceManifestRevision ?? null });
        } catch { failed.add(scope); }
      });
      valid();
      const soulScopes = rebuild.filter(usesSoul);
      let memory: Awaited<ReturnType<typeof loadMarkdownMemory>> = null;
      if (soulScopes.length) {
        try {
          memory = await loadMarkdownMemory({ userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken, forceRefresh: true });
          valid();
          if (!memory || memory.syncStatus && memory.syncStatus !== "synced" ||
              (memory.persisted || memory.dataVersion !== undefined) && memory.dataVersion !== sources.one_memory?.contentRevision) throw new Error("Private memory readback pending");
        } catch { for (const scope of soulScopes) failed.add(scope); memory = null; }
      }
      const deleted = new Set((memory?.deletedFactLabels ?? []).map(soulFactKey));
      // Durable deletion markers dominate retained labels in older documents.
      // Neither a labelled override nor a derived fact may resurrect them.
      const labelled = new Map([...readLabelledSoulFacts(memory?.markdown)].filter(([label]) => !deleted.has(label)));
      const facts = projectApprovedSoulFacts({ approvedScopes: rebuild, markdown: memory?.markdown, now })
        .filter(fact => !deleted.has(soulFactKey(fact.sourceLabel)) && !pathBlocked(fact.relativePath, sources[scopeDomain(fact.scope)]!));
      let birth: string | null = labelled.get("date of birth")?.value ?? null;
      let ageRevision = memory?.dataVersion ?? null;
      let ageManifestRevision: number | null = null;
      let unreadableDob = false;
      if (!birth && !deleted.has("date of birth") && scopeBlocked(CANONICAL_DOB, sources.identity ?? { domain: "identity", contentRevision: null, manifestRevision: null, manifestFingerprint: null, absent: true })) unreadableDob = true;
      if (!birth && !deleted.has("date of birth") && includeDob && memory) {
        try {
          const result = await buildConsentExportForScope({ ...params, scope: CANONICAL_DOB, readSession });
          valid();
          if (result.sourceContentRevision !== sources.identity?.contentRevision || result.sourceManifestRevision !== sources.identity?.manifestRevision) throw new Error("DOB revision changed during derivation");
          const value = getPath(record(result.payload).identity ?? result.payload, "identity_profile.date_of_birth");
          birth = typeof value === "string" ? value : null;
          ageRevision = result.sourceContentRevision ?? null; ageManifestRevision = result.sourceManifestRevision ?? null;
        } catch { unreadableDob = true; }
      }
      const age = deleted.has("date of birth") ? null : ageFromDateOfBirth(birth, now);
      for (const scope of rebuild) {
        if (policyFailed.has(scope)) continue;
        const original = originals.get(scope);
        const domain = scopeDomain(scope);
        const payload = structuredClone(record(original?.payload[domain] ?? original?.payload));
        let contentRevision = original?.contentRevision ?? null;
        let manifestRevision = original?.manifestRevision ?? null;
        if (memory && usesSoul(scope)) {
          // A successfully checked Soul source can settle the synthetic optional
          // identity selectors even when no structured counterpart exists.
          // A failed materialized export remains unavailable even when another
          // document contains a matching fact. Only confirmed absent selectors
          // or a successful exact export admit the owner-labelled projection.
          if (original || !hasStructuredCounterpart(scope, sources[domain]!)) failed.delete(scope);
          const removed = SCOPE_PATH_TO_LABEL.filter(([, label]) => deleted.has(soulFactKey(label))).map(([path]) => path);
          if (deleted.has("sex")) removed.push("profile.sex");
          if (deleted.has("legal name") && isOwnProfileNameScope(scope)) removed.push(scopePath(scope));
          for (const path of removed) {
            const factDomain = path.startsWith("profile.") && path !== "profile.sex" ? "professional" : "identity";
            if (covers(scope, factDomain, path) && getPath(payload, path) !== undefined) { setPath(payload, path, undefined); contentRevision = memory.dataVersion ?? null; manifestRevision = null; }
          }
          for (const fact of facts.filter(fact => fact.scope === scope)) { setPath(payload, fact.relativePath, fact.value); contentRevision = memory.dataVersion ?? null; manifestRevision = null; }
          if (isOwnProfileNameScope(scope) && labelled.has("legal name")) {
            setPath(payload, scopePath(scope), labelled.get("legal name")!.value); contentRevision = memory.dataVersion ?? null; manifestRevision = null;
          }
          if (isLegacySexScope(scope) && !pathBlocked("profile.sex", sources[domain]!) && (labelled.has("sex") || deleted.has("sex")) &&
              (scope !== "attr.professional.profile.*" || getPath(payload, "profile.sex") !== undefined)) {
            setPath(payload, "profile.sex", deleted.has("sex") ? undefined : labelled.get("sex")!.value); contentRevision = memory.dataVersion ?? null; manifestRevision = null;
          }
          for (const path of agePaths(scope).filter(path => !pathBlocked(path, sources[domain]!) && (scope !== "attr.professional.profile.*" || getPath(payload, path) !== undefined))) {
            setPath(payload, path, age === null ? undefined : String(age));
            contentRevision = ageRevision; manifestRevision = ageManifestRevision;
          }
        }
        if (unreadableDob && requiresAgeDerivation(scope, sources)) failed.add(scope);
        if (isOwnProfileNameScope(scope) && !hasValue(payload) && !failed.has(scope) && params.ownerIdentity?.displayName?.trim()) {
          setPath(payload, scopePath(scope), params.ownerIdentity.displayName.trim()); contentRevision = null; manifestRevision = null;
        }
        if (isAnswerProfilePhotoScope(scope) && params.ownerIdentity) {
          failed.delete(scope);
          for (const key of Object.keys(payload)) delete payload[key];
          const photo = answerProfilePhotoUrl(params.ownerIdentity.photoUrl);
          if (photo) setPath(payload, scopePath(scope), photo);
          contentRevision = null; manifestRevision = null;
        }
        if (failed.has(scope)) continue;
        slices.set(scope, { admissionVersion: 2, scope, payload, contentRevision, manifestRevision, sources: dependencies(scope, sources).map(dependency => sources[dependency]!),
          accountFingerprint: accountFingerprints.get(scope) ?? null, freshnessDate: requiresAgeDerivation(scope, sources) ? date : null, builtAt });
      }
      valid();
      const replacements = rebuild.map(scope => slices.get(scope)).filter((slice): slice is MemoryScopeSlice => Boolean(slice));
      if (replacements.length) {
        await persistMemoryScopeSlices({ ...params, slices: replacements, beforeEffect: async () => { valid(); } });
        params.onRefreshTiming?.(refreshStarted);
        // Recheck authoritative revisions after persisting the derived slice.
        // The derived write changes the global PKM epoch itself. Fence a fresh
        // revision check after that write rather than rejecting our own save.
        const verificationEpoch = currentPkmSourceEpoch(params.userId, domains);
        const verified = await readMemoryScopeSourceRevisions({ ...params, domains });
        if (!isVaultSessionEpochCurrent(epoch) || currentPkmSourceEpoch(params.userId, domains) !== verificationEpoch ||
            [...slices].some(([scope, slice]) => !sameSources(slice.sources, dependencies(scope, verified).map(domain => verified[domain]!)))) return unavailable();
      }
      if (!isVaultSessionEpochCurrent(epoch) || !params.now && scopes.some(isAgeScope) && new Date().toISOString().slice(0, 10) !== date) return unavailable();
      return guardedResult(scopes.every(scope => slices.has(scope)));
    }
    valid();
    return guardedResult(true);
  } catch { return unavailable(); }
}
