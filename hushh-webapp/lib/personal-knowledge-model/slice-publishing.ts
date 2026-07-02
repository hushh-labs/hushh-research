// hushh-webapp/lib/personal-knowledge-model/slice-publishing.ts
/**
 * Shared PKM slice-posture publishing flow.
 *
 * Single source of truth for the consent-first "publish a slice" write path,
 * reused by both the Profile sharing controls and the One → Marketplace owner
 * surface. Extracting it here keeps the sensitive vault-write flow (decrypt the
 * section, build the safe projection, set the posture, publish the projection)
 * from being duplicated — the repo forbids forking a canonical flow.
 *
 * Setting a section to `default_available` publishes ONLY a safe projection,
 * never raw PKM. Nothing is shared until the owner flips the posture, and
 * per-buyer consent still gates every actual read.
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
        default_projection_ready:
          visibilityPosture === "default_available" ? entry.default_projection_ready === true : false,
        default_projection_updated_at:
          visibilityPosture === "default_available" ? entry.default_projection_updated_at || null : null,
      };
    });
  }

  if (!updated && Array.isArray(nextManifest.top_level_scope_paths)) {
    updated = nextManifest.top_level_scope_paths.includes(target.topLevelScopePath);
  }

  return updated ? nextManifest : manifest;
}

export function defaultAvailableScopeForPermission(
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
  vaultKey?: string;
  vaultOwnerToken: string;
  source?: string;
}): Promise<{ manifest: DomainManifest }> {
  const { userId, domain, domainTitle, permission, nextPosture, previousManifest } = params;

  let projectionPayload: Record<string, unknown> | null = null;
  if (nextPosture === "default_available" && params.vaultKey) {
    const sectionData = await PersonalKnowledgeModelService.loadDomainData({
      userId,
      domain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      segmentIds: [permission.topLevelScopePath],
    });
    const presentation = buildPkmSectionPreviewPresentation({
      domain,
      domainTitle,
      permissionLabel: permission.label,
      permissionDescription: permission.description || null,
      topLevelScopePath: permission.topLevelScopePath,
      value: sectionData,
    });
    projectionPayload = {
      projection_kind: "pkm_default_available_section_v1",
      domain,
      domain_title: domainTitle,
      section: permission.topLevelScopePath,
      label: permission.label,
      description: permission.description || null,
      presentation,
    };
  }

  const result = await PersonalKnowledgeModelService.updateScopeExposure({
    userId,
    domain,
    expectedManifestVersion: previousManifest.manifest_version,
    vaultOwnerToken: params.vaultOwnerToken,
    // Only revoke existing grants when RESTRICTING access. Publishing a section
    // as `default_available` is opening it up — there is nothing to revoke, and
    // revoking here can sweep up the owner's own active session token (observed:
    // scope-exposure revoking the vault-owner HCT, 401-ing the projection call).
    revokeMatchingActiveGrants: nextPosture !== "default_available",
    changes: [
      {
        scopeHandle: permission.scopeHandle || undefined,
        topLevelScopePath: permission.topLevelScopePath,
        exposureEnabled: nextPosture !== "private",
        visibilityPosture: nextPosture,
      },
    ],
  });

  let updatedManifest = result.manifest ?? previousManifest;

  if (nextPosture === "default_available" && projectionPayload) {
    const projectionResult = await PersonalKnowledgeModelService.publishDefaultAvailableProjection({
      userId,
      domain,
      scope: defaultAvailableScopeForPermission(domain, permission.topLevelScopePath),
      scopeHandle: permission.scopeHandle || undefined,
      topLevelScopePath: permission.topLevelScopePath,
      projectionPayload,
      manifestVersion: result.manifestVersion ?? previousManifest.manifest_version,
      vaultOwnerToken: params.vaultOwnerToken,
      metadata: { source: params.source || "slice_publishing" },
    });
    updatedManifest = projectionResult.manifest ?? updatedManifest;
  }

  return { manifest: updatedManifest };
}
