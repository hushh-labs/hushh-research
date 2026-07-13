// hushh-webapp/lib/personal-knowledge-model/slice-publishing.ts
/**
 * Shared PKM consent-posture and public-profile publishing flow.
 *
 * Single source of truth for the consent-first "publish a slice" write path,
 * reused by both the Profile sharing controls and the One → Marketplace owner
 * surface. Extracting it here keeps the sensitive vault-write flow (decrypt the
 * section, build a safe public projection, and persist it)
 * from being duplicated — the repo forbids forking a canonical flow.
 *
 * Public-profile publishing never changes the encrypted PKM consent posture.
 * It publishes only a safe projection; private PKM reads remain consent-gated.
 */

import {
  PersonalKnowledgeModelService,
  type PkmVisibilityPosture,
} from "@/lib/services/personal-knowledge-model-service";
import { type DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { buildPkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";

export interface SlicePermission {
  scopeHandle: string | null;
  label: string;
  description?: string | null;
  topLevelScopePath: string;
}

export function cloneManifest(manifest: DomainManifest | null): DomainManifest | null {
  if (!manifest) return null;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(manifest) as DomainManifest;
    } catch {
      // Fall through to JSON clone.
    }
  }
  return JSON.parse(JSON.stringify(manifest)) as DomainManifest;
}

export function applyManifestExposureChange(
  manifest: DomainManifest | null | undefined,
  target: { scopeHandle?: string | null; topLevelScopePath: string },
  visibilityPosture: PkmVisibilityPosture,
): DomainManifest | null | undefined {
  if (!manifest) return manifest;
  const nextManifest = cloneManifest(manifest);
  if (!nextManifest) return nextManifest;

  let updated = false;
  if (Array.isArray(nextManifest.scope_registry)) {
    nextManifest.scope_registry = nextManifest.scope_registry.map((entry) => {
      const projection =
        entry.summary_projection && typeof entry.summary_projection === "object"
          ? entry.summary_projection
          : {};
      const matchesHandle = target.scopeHandle && entry.scope_handle === target.scopeHandle;
      const matchesPath =
        String(projection.top_level_scope_path || "").trim() === target.topLevelScopePath;
      if (!matchesHandle && !matchesPath) {
        return entry;
      }
      updated = true;
      return {
        ...entry,
        exposure_enabled: visibilityPosture !== "private",
        visibility_posture: visibilityPosture,
        default_projection_ready: false,
        default_projection_updated_at: null,
      };
    });
  }

  if (!updated && Array.isArray(nextManifest.top_level_scope_paths)) {
    updated = nextManifest.top_level_scope_paths.includes(target.topLevelScopePath);
  }

  return updated ? nextManifest : manifest;
}

export function consentScopeForPermission(
  domainKey: string,
  topLevelScopePath: string,
): string {
  return `attr.${domainKey}.${topLevelScopePath}.*`;
}

/**
 * Run the network write flow for changing a section's visibility posture.
 * Returns the updated manifest. Pure of React state — callers own optimistic
 * UI, pending indicators, and error rollback.
 */
export async function applySlicePosture(params: {
  userId: string;
  domain: string;
  domainTitle: string;
  permission: SlicePermission;
  nextPosture: PkmVisibilityPosture;
  previousManifest: DomainManifest;
  vaultOwnerToken: string;
}): Promise<{ manifest: DomainManifest }> {
  const { userId, domain, permission, nextPosture, previousManifest } = params;

  const result = await PersonalKnowledgeModelService.updateScopeExposure({
    userId,
    domain,
    expectedManifestVersion: previousManifest.manifest_version,
    vaultOwnerToken: params.vaultOwnerToken,
    revokeMatchingActiveGrants: nextPosture === "private",
    changes: [
      {
        scopeHandle: permission.scopeHandle || undefined,
        topLevelScopePath: permission.topLevelScopePath,
        exposureEnabled: nextPosture === "consent_required",
        visibilityPosture: nextPosture,
      },
    ],
  });

  return { manifest: result.manifest ?? previousManifest };
}

/** Publish a safe owner-controlled public profile without changing PKM consent. */
export async function publishPublicProfileForPermission(params: {
  userId: string;
  domain: string;
  domainTitle: string;
  permission: SlicePermission;
  vaultKey: string;
  vaultOwnerToken: string;
  manifestVersion?: number;
  source?: string;
}): Promise<{ manifest: DomainManifest | null; publicProfileHandle: string | null }> {
  const sectionData = await PersonalKnowledgeModelService.loadDomainData({
    userId: params.userId,
    domain: params.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    segmentIds: [params.permission.topLevelScopePath],
  });
  const presentation = buildPkmSectionPreviewPresentation({
    domain: params.domain,
    domainTitle: params.domainTitle,
    permissionLabel: params.permission.label,
    permissionDescription: params.permission.description || null,
    topLevelScopePath: params.permission.topLevelScopePath,
    value: sectionData,
  });
  const projectionResult = await PersonalKnowledgeModelService.publishPublicProfileProjection({
    userId: params.userId,
    domain: params.domain,
    scopeHandle: params.permission.scopeHandle || undefined,
    topLevelScopePath: params.permission.topLevelScopePath,
    projectionPayload: {
      projection_kind: "public_profile_projection.v1",
      domain: params.domain,
      domain_title: params.domainTitle,
      section: params.permission.topLevelScopePath,
      label: params.permission.label,
      description: params.permission.description || null,
      presentation,
    },
    manifestVersion: params.manifestVersion,
    vaultOwnerToken: params.vaultOwnerToken,
    metadata: { source: params.source || "public_profile_publishing" },
  });
  return {
    manifest: projectionResult.manifest,
    publicProfileHandle: projectionResult.publicProfileHandle ?? null,
  };
}
