"use client";

import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  isPrivatePkmExportScope,
  excludePrivatePkmDomains,
} from "@/lib/consent/pkm-scope-policy";
import { externalizableManifestLeaves } from "@/lib/consent/manifest-exposure";
import type { PkmScopeRegistryEntry } from "@/lib/personal-knowledge-model/manifest";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { currentPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";

const PKM_READ = "pkm.read";
const ATTR_SCOPE_REGEX = /^attr\.([a-zA-Z0-9_]+)(?:\.(.+))?$/;

export class ConsentExportNoDataError extends Error {
  constructor(
    message: string,
    readonly diagnostics?: {
      stage: "scope_projection";
      approvedPathCount: number;
      exactTopLevelMatches: number;
      normalizedTopLevelMatches: number;
      domainWrapped: boolean;
      firstMissingPathDepth: number | null;
      selectedLeafKind: string;
    },
  ) {
    super(message);
    this.name = "ConsentExportNoDataError";
  }
}

function parseAttrScope(scope: string): {
  domain: string;
  path: string | null;
  isWildcard: boolean;
} | null {
  const match = scope.match(ATTR_SCOPE_REGEX);
  if (!match) return null;
  const domain = match[1] ?? "";
  const remainder = match[2] ?? "";
  const isWildcard = remainder === "*" || remainder.endsWith(".*");
  const normalizedPath = remainder.replace(/\.\*$/, "").trim();
  return {
    domain,
    path: normalizedPath && normalizedPath !== "*" ? normalizedPath : null,
    isWildcard,
  };
}

function resolveApprovedPaths(
  scope: string,
  manifest: {
    externalizable_paths?: string[];
    paths?: Array<{
      json_path?: string;
      path_type?: string;
      exposure_eligibility?: boolean;
    }>;
    manifest_version?: number;
    scope_registry?: PkmScopeRegistryEntry[];
  } | null,
): string[] {
  const parsed = parseAttrScope(scope);
  if (!parsed) {
    return [];
  }
  const externalizablePaths = manifest ? externalizableManifestLeaves(manifest) : [];
  if (!parsed.path) return externalizablePaths;
  return externalizablePaths.filter(
    (path) => path === parsed.path || path.startsWith(`${parsed.path}.`),
  );
}

function hasShareableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value))
    return value.some((item) => hasShareableValue(item));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => key !== "__export_metadata" && hasShareableValue(item),
    );
  }
  return false;
}

function normalizeSegmentCandidate(path: string): string | null {
  const [topLevel] = String(path || "").split(".", 1);
  const normalized = String(topLevel || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

function topLevelSegmentsForPaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths
        .map((path) => normalizeSegmentCandidate(path))
        .filter((segment): segment is string => Boolean(segment)),
    ),
  ];
}

function mergeSegmentIds(
  ...groups: Array<string[] | null | undefined>
): string[] {
  return [
    ...new Set(
      groups.flatMap((group) =>
        (group || [])
          .map((segmentId) => normalizeSegmentCandidate(segmentId))
          .filter((segmentId): segmentId is string => Boolean(segmentId)),
      ),
    ),
  ];
}

// Paths never included in a consent export/reply even when they fall under an
// approved scope. MRZ encodes the entire passport in machine-readable form, so
// it is redundant with the human-readable fields and needlessly sensitive to share.
const REDACTED_EXPORT_PATH_RE = /(^|\.)mrz(_line\d+)?$/i;

function isRedactedExportPath(path: string): boolean {
  return REDACTED_EXPORT_PATH_RE.test(path);
}

export type BuiltConsentExport = {
  payload: Record<string, unknown>;
  sourceContentRevision?: number;
  sourceManifestRevision?: number;
};

export interface ConsentExportReadSession {
  build(scope: string): Promise<BuiltConsentExport>;
}

/** One coherent domain read per answer, with exact scope projection after decryption.
 * Encrypted cached projections are reusable only after current server revisions
 * and exposure posture have been checked. Drive's ordinary export path stays separate.
 */
export function createConsentExportReadSession(params: {
  userId: string; scopes: readonly string[]; vaultKey: string; vaultOwnerToken: string;
}): ConsentExportReadSession {
  const epoch = snapshotVaultSessionEpoch();
  const sourceEpoch = currentPkmInvalidationEpoch(params.userId);
  const valid = () => {
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
    if (currentPkmInvalidationEpoch(params.userId) !== sourceEpoch)
      throw new Error("Memory sources changed during preparation; retry required");
  };
  const scopes = [...new Set(params.scopes)].sort();
  const reads = new Map<string, Promise<Record<string, BuiltConsentExport>>>();
  const readDomain = async (domain: string): Promise<Record<string, BuiltConsentExport>> => {
    valid();
    const selected = scopes.filter(scope => parseAttrScope(scope)?.domain === domain);
    if (selected.some(isPrivatePkmExportScope)) throw new Error("Private source cannot be exported");
    const full = selected.some(scope => !parseAttrScope(scope)?.path);
    const snapshot = await PersonalKnowledgeModelService.getDomainSnapshot({
      userId: params.userId, domain, vaultOwnerToken: params.vaultOwnerToken,
      // Discover the current manifest and ciphertext together. A filtered 404
      // only proves that a guessed segment is absent, not that the domain is.
      // Decryption below is restricted to the approved paths' actual segments.
      force: true,
    });
    valid();
    // HTTP 404 is confirmed absence; failed/locked reads throw and remain retryable.
    if (!snapshot) return Object.fromEntries(selected.map(scope => [scope, { payload: {} }]));
    if (snapshot.userId !== params.userId || snapshot.domain !== domain || !snapshot.manifest)
      throw new Error("Scope manifest could not be verified");
    const paths = selected.map(scope => resolveApprovedPaths(scope, snapshot.manifest).filter(path => !isRedactedExportPath(path)));
    if (paths.some(entries => !entries.length)) throw new Error("Approved scope changed; review required");
    const legacy = snapshot.encryptedBlob.storageMode === "legacy_full_blob";
    const segments = legacy ? ["root"] : full ? [] : [...new Set(paths.flatMap(entries => entries.flatMap(path => {
      const declared = PersonalKnowledgeModelService.resolveSegmentIdsForPaths({ manifest: snapshot.manifest, paths: [path] });
      // Historical manifests may declare root for a physically partitioned
      // top-level value. Recover that exact path only, never arbitrary siblings.
      const present = mergeSegmentIds(declared, topLevelSegmentsForPaths([path]))
        .filter(segment => snapshot.segmentIds.includes(segment));
      if (!present.length) throw new Error("Approved scope segments could not be read");
      return present;
    })))];
    if (segments.some(segment => !snapshot.segmentIds.includes(segment)))
      throw new Error("Approved scope segments could not be read");
    const signature = JSON.stringify(["wallet-projection-2", domain, selected, paths, snapshot.contentRevision, snapshot.manifestRevision, snapshot.etag]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
    const resourceKey = "answer_scope_projection:v2:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const cached = await SecureResourceCacheService.read<{ signature: string; exports: Record<string, BuiltConsentExport> }>({
      userId: params.userId, vaultKey: params.vaultKey, resourceKey,
    });
    valid();
    if (cached?.signature === signature && selected.every(scope => cached.exports?.[scope])) return cached.exports;
    const data = await PersonalKnowledgeModelService.decryptDomainSnapshot({ snapshot, vaultKey: params.vaultKey, segmentIds: segments });
    valid();
    const exports = Object.fromEntries(selected.map((scope, index) => [scope, {
      payload: {
        ...projectDomainDataForScope({ domain, scope, domainData: data, approvedPaths: paths[index]! }),
        __export_metadata: { scope, source_domain: domain, approved_paths: paths[index]!, manifest_version: snapshot!.manifestRevision },
      },
      sourceContentRevision: snapshot!.contentRevision,
      sourceManifestRevision: snapshot!.manifestRevision,
    }]));
    await SecureResourceCacheService.write({ userId: params.userId, vaultKey: params.vaultKey, resourceKey,
      value: { signature, exports }, ttlMs: 24 * 60 * 60 * 1000 });
    valid();
    return exports;
  };
  return { async build(scope) {
    valid();
    const parsed = parseAttrScope(scope);
    if (!parsed || !scopes.includes(scope)) throw new Error("Scope not approved");
    let pending = reads.get(parsed.domain);
    if (!pending) { pending = readDomain(parsed.domain); reads.set(parsed.domain, pending); }
    return (await pending)[scope]!;
  } };
}

export async function buildConsentExportForScope(params: {
  userId: string;
  scope: string;
  vaultKey: string;
  vaultOwnerToken: string;
  readSession?: ConsentExportReadSession;
}): Promise<BuiltConsentExport> {
  if (params.readSession) return params.readSession.build(params.scope);
  if (isPrivatePkmExportScope(params.scope)) {
    throw new ConsentExportNoDataError(
      "Private analysis source material cannot be exported.",
    );
  }
  if (params.scope === PKM_READ) {
    const fullBlob = excludePrivatePkmDomains(
      await PersonalKnowledgeModelService.loadFullBlob({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      }),
    );
    const encryptedRoot = await PersonalKnowledgeModelService.getEncryptedData(
      params.userId,
      params.vaultOwnerToken,
    ).catch(() => null);
    const availableDomains = Object.keys(fullBlob);
    return {
      payload:
        availableDomains.length === 0
          ? {}
          : {
              ...fullBlob,
              __export_metadata: {
                scope: params.scope,
                export_timestamp: new Date().toISOString(),
                available_domains: availableDomains,
              },
            },
      sourceContentRevision:
        typeof encryptedRoot?.dataVersion === "number"
          ? encryptedRoot.dataVersion
          : undefined,
    };
  }

  if (!params.scope.startsWith("attr.")) {
    return { payload: {} };
  }

  const requestedScope = parseAttrScope(params.scope);
  if (!requestedScope) {
    return { payload: {} };
  }

  const manifest = await PersonalKnowledgeModelService.getDomainManifest(
    params.userId,
    requestedScope.domain,
    params.vaultOwnerToken,
    true,
  ).catch(() => null);
  // Consent authorizes an exact path, never a semantically similar field. A
  // missing or stale projection requires fresh review, not path substitution.
  const parsedScope = requestedScope;
  const approvedPaths = resolveApprovedPaths(params.scope, manifest).filter(
    (path) => !isRedactedExportPath(path),
  );
  if (approvedPaths.length === 0) {
    throw new ConsentExportNoDataError(
      "The requested information is no longer available to share.",
    );
  }
  const isDomainWideScope = !parsedScope.path;
  const manifestSegmentIds = isDomainWideScope
    ? []
    : PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
        manifest,
        paths: approvedPaths,
      });
  const pathSegmentIds = isDomainWideScope
    ? []
    : topLevelSegmentsForPaths(
        approvedPaths.length ? approvedPaths : [parsedScope.path ?? ""],
      );
  const segmentIds = mergeSegmentIds(manifestSegmentIds, pathSegmentIds);
  let effectiveSegmentIds = segmentIds;
  let encryptedDomainBlob = await PersonalKnowledgeModelService.getDomainData(
    params.userId,
    parsedScope.domain,
    params.vaultOwnerToken,
    effectiveSegmentIds,
  );
  if (
    !encryptedDomainBlob &&
    !isDomainWideScope &&
    effectiveSegmentIds.length > 0
  ) {
    effectiveSegmentIds = [];
    encryptedDomainBlob = await PersonalKnowledgeModelService.getDomainData(
      params.userId,
      parsedScope.domain,
      params.vaultOwnerToken,
      effectiveSegmentIds,
    );
  }
  if (!encryptedDomainBlob) {
    throw new ConsentExportNoDataError(
      `No approved PKM information is available for ${parsedScope.domain.replaceAll("_", " ")}.`,
    );
  }

  const buildPayload = (
    domainData: Record<string, unknown>,
    segmentIdsForExport: string[],
  ) => ({
    ...projectDomainDataForScope({
      domain: parsedScope.domain,
      scope: params.scope,
      domainData,
      approvedPaths,
    }),
    __export_metadata: {
      scope: params.scope,
      source_domain: parsedScope.domain,
      manifest_version: manifest?.manifest_version ?? null,
      approved_paths: approvedPaths,
      approved_segment_ids: segmentIdsForExport,
      export_timestamp: new Date().toISOString(),
    },
  });

  let domainData = await PersonalKnowledgeModelService.loadDomainData({
    userId: params.userId,
    domain: parsedScope.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    segmentIds: effectiveSegmentIds,
  });
  let payload = buildPayload(domainData || {}, effectiveSegmentIds);

  if (
    !hasShareableValue(payload) &&
    !isDomainWideScope &&
    effectiveSegmentIds.length > 0
  ) {
    const fullDomainBlob = await PersonalKnowledgeModelService.getDomainData(
      params.userId,
      parsedScope.domain,
      params.vaultOwnerToken,
      [],
    );
    if (fullDomainBlob) {
      const fullDomainData = await PersonalKnowledgeModelService.loadDomainData(
        {
          userId: params.userId,
          domain: parsedScope.domain,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          segmentIds: [],
        },
      );
      encryptedDomainBlob = fullDomainBlob;
      effectiveSegmentIds = [];
      domainData = fullDomainData;
      payload = buildPayload(domainData || {}, effectiveSegmentIds);
    }
  }

  if (!hasShareableValue(payload)) {
    const topLevels = new Set(approvedPaths.map((path) => path.split(".")[0]));
    const storedKeys = Object.keys(domainData || {});
    let selected: unknown = domainData;
    let firstMissingPathDepth: number | null = null;
    for (const [depth, key] of (approvedPaths[0] || "").split(".").entries()) {
      if (
        !selected ||
        typeof selected !== "object" ||
        !Object.hasOwn(selected, key)
      ) {
        firstMissingPathDepth = depth;
        selected = undefined;
        break;
      }
      selected = (selected as Record<string, unknown>)[key];
    }
    throw new ConsentExportNoDataError(
      "No shareable information was found for the selected fields.",
      {
        stage: "scope_projection",
        approvedPathCount: approvedPaths.length,
        exactTopLevelMatches: storedKeys.filter((key) => topLevels.has(key))
          .length,
        normalizedTopLevelMatches: storedKeys.filter((key) =>
          topLevels.has(normalizeSegmentCandidate(key) || ""),
        ).length,
        domainWrapped: Object.hasOwn(domainData || {}, parsedScope.domain),
        firstMissingPathDepth,
        selectedLeafKind:
          selected === null
            ? "null"
            : Array.isArray(selected)
              ? "array"
              : typeof selected,
      },
    );
  }
  return {
    payload,
    sourceContentRevision:
      typeof encryptedDomainBlob.dataVersion === "number"
        ? encryptedDomainBlob.dataVersion
        : undefined,
    sourceManifestRevision:
      typeof manifest?.manifest_version === "number"
        ? manifest.manifest_version
        : undefined,
  };
}
