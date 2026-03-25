"use client";

import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

const PKM_READ = "pkm.read";
const ATTR_SCOPE_REGEX = /^attr\.([a-zA-Z0-9_]+)(?:\.(.+))?$/;

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
  const segmentIds = PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
    manifest,
    paths: approvedPaths,
  });
  const encryptedDomainBlob = await PersonalKnowledgeModelService.getDomainData(
    params.userId,
    parsedScope.domain,
    params.vaultOwnerToken,
    segmentIds
  );
  if (!encryptedDomainBlob) {
    return {
      payload: { [parsedScope.domain]: {} },
      sourceManifestRevision:
        typeof manifest?.manifest_version === "number" ? manifest.manifest_version : undefined,
    };
  }

  const domainData = await PersonalKnowledgeModelService.loadDomainData({
    userId: params.userId,
    domain: parsedScope.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    segmentIds,
  });
  const resolvedDomainData = domainData || {};
  return {
    payload: {
      ...projectDomainDataForScope({
        domain: parsedScope.domain,
        scope: params.scope,
        domainData: resolvedDomainData,
      }),
      __export_metadata: {
        scope: params.scope,
        source_domain: parsedScope.domain,
        manifest_version: manifest?.manifest_version ?? null,
        approved_paths: approvedPaths,
        approved_segment_ids: segmentIds,
        export_timestamp: new Date().toISOString(),
      },
    },
    sourceContentRevision:
      typeof encryptedDomainBlob.dataVersion === "number"
        ? encryptedDomainBlob.dataVersion
        : undefined,
    sourceManifestRevision:
      typeof manifest?.manifest_version === "number" ? manifest.manifest_version : undefined,
  };
}
