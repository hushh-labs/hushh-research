"use client";

import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

const PKM_READ = "pkm.read";
const ATTR_SCOPE_REGEX = /^attr\.([a-zA-Z0-9_]+)(?:\.(.+))?$/;

export class ConsentExportNoDataError extends Error {
  constructor(message: string) {
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
    paths?: Array<{ json_path?: string }>;
    manifest_version?: number;
  } | null
): string[] {
  const parsed = parseAttrScope(scope);
  if (!parsed) {
    return [];
  }
  if (!parsed.path) {
    return manifest?.externalizable_paths || [];
  }

  const manifestPaths = (manifest?.paths || [])
    .map((entry) => entry.json_path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  if (!parsed.isWildcard) {
    return [parsed.path];
  }

  return manifestPaths.filter(
    (path) => path === parsed.path || path.startsWith(`${parsed.path}.`)
  );
}

function hasShareableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => hasShareableValue(item));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => key !== "__export_metadata" && hasShareableValue(item)
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
        .filter((segment): segment is string => Boolean(segment))
    ),
  ];
}

function mergeSegmentIds(...groups: Array<string[] | null | undefined>): string[] {
  return [
    ...new Set(
      groups.flatMap((group) =>
        (group || [])
          .map((segmentId) => normalizeSegmentCandidate(segmentId))
          .filter((segmentId): segmentId is string => Boolean(segmentId))
      )
    ),
  ];
}

function assertShareablePayload(scope: string, payload: Record<string, unknown>): void {
  if (hasShareableValue(payload)) return;
  throw new ConsentExportNoDataError(
    `No shareable data was found for ${scope.replace(/^attr\./, "").replace(/\.\*$/, "").replaceAll(".", " ")}.`
  );
}

export type BuiltConsentExport = {
  payload: Record<string, unknown>;
  sourceContentRevision?: number;
  sourceManifestRevision?: number;
};

export async function buildConsentExportForScope(params: {
  userId: string;
  scope: string;
  vaultKey: string;
  vaultOwnerToken: string;
}): Promise<BuiltConsentExport> {
  if (params.scope === PKM_READ) {
    const fullBlob = await PersonalKnowledgeModelService.loadFullBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });
    const encryptedRoot = await PersonalKnowledgeModelService.getEncryptedData(
      params.userId,
      params.vaultOwnerToken
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
        typeof encryptedRoot?.dataVersion === "number" ? encryptedRoot.dataVersion : undefined,
    };
  }

  if (!params.scope.startsWith("attr.")) {
    return { payload: {} };
  }

  const parsedScope = parseAttrScope(params.scope);
  if (!parsedScope) {
    return { payload: {} };
  }

  const manifest = await PersonalKnowledgeModelService.getDomainManifest(
    params.userId,
    parsedScope.domain,
    params.vaultOwnerToken
  ).catch(() => null);
  const approvedPaths = resolveApprovedPaths(params.scope, manifest);
  const isDomainWideScope = !parsedScope.path;
  const manifestSegmentIds = isDomainWideScope
    ? []
    : PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
        manifest,
        paths: approvedPaths,
      });
  const pathSegmentIds = isDomainWideScope
    ? []
    : topLevelSegmentsForPaths(approvedPaths.length ? approvedPaths : [parsedScope.path ?? ""]);
  const segmentIds = mergeSegmentIds(manifestSegmentIds, pathSegmentIds);
  let effectiveSegmentIds = segmentIds;
  let encryptedDomainBlob = await PersonalKnowledgeModelService.getDomainData(
    params.userId,
    parsedScope.domain,
    params.vaultOwnerToken,
    effectiveSegmentIds
  );
  if (!encryptedDomainBlob && !isDomainWideScope && effectiveSegmentIds.length > 0) {
    effectiveSegmentIds = [];
    encryptedDomainBlob = await PersonalKnowledgeModelService.getDomainData(
      params.userId,
      parsedScope.domain,
      params.vaultOwnerToken,
      effectiveSegmentIds
    );
  }
  if (!encryptedDomainBlob) {
    throw new ConsentExportNoDataError(
      `No approved PKM data is available for ${parsedScope.domain.replaceAll("_", " ")}.`
    );
  }

  const buildPayload = (
    domainData: Record<string, unknown>,
    segmentIdsForExport: string[]
  ) => ({
    ...projectDomainDataForScope({
      domain: parsedScope.domain,
      scope: params.scope,
      domainData,
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

  if (!hasShareableValue(payload) && !isDomainWideScope && effectiveSegmentIds.length > 0) {
    const fullDomainBlob = await PersonalKnowledgeModelService.getDomainData(
      params.userId,
      parsedScope.domain,
      params.vaultOwnerToken,
      []
    );
    if (fullDomainBlob) {
      const fullDomainData = await PersonalKnowledgeModelService.loadDomainData({
        userId: params.userId,
        domain: parsedScope.domain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        segmentIds: [],
      });
      encryptedDomainBlob = fullDomainBlob;
      effectiveSegmentIds = [];
      domainData = fullDomainData;
      payload = buildPayload(domainData || {}, effectiveSegmentIds);
    }
  }

  assertShareablePayload(params.scope, payload);
  return {
    payload,
    sourceContentRevision:
      typeof encryptedDomainBlob.dataVersion === "number"
        ? encryptedDomainBlob.dataVersion
        : undefined,
    sourceManifestRevision:
      typeof manifest?.manifest_version === "number" ? manifest.manifest_version : undefined,
  };
}
