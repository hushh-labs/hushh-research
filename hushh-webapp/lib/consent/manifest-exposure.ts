import type { PkmScopeRegistryEntry } from "@/lib/personal-knowledge-model/manifest";
import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";

type ExposureManifest = {
  externalizable_paths?: string[];
  paths?: Array<{ json_path?: string; path_type?: string; exposure_eligibility?: boolean }>;
  scope_registry?: PkmScopeRegistryEntry[];
};

function privateScopeRoots(manifest: ExposureManifest): string[] {
  return (manifest.scope_registry ?? []).flatMap(entry => {
    const projection = entry.summary_projection ?? {};
    if (entry.exposure_enabled !== false && entry.visibility_posture !== "private" &&
        projection.consumer_visible !== false && projection.internal_only !== true) return [];
    return typeof projection.top_level_scope_path === "string" ? [projection.top_level_scope_path] : entry.segment_ids ?? [];
  });
}

/** The same manifest admission applies to exact exports and owner-labelled projections. */
export function externalizableManifestLeaves(manifest: ExposureManifest): string[] {
  const leaves = new Set((manifest.paths ?? []).filter(entry => entry.path_type === "leaf" &&
    entry.exposure_eligibility !== false && typeof entry.json_path === "string").map(entry => entry.json_path));
  const blockedRoots = privateScopeRoots(manifest);
  return (manifest.externalizable_paths ?? []).filter(path => typeof path === "string" && path.length > 0 &&
    leaves.has(path) && !isInternalManifestPath(path) &&
    !blockedRoots.some(root => path === root || path.startsWith(`${root}.`)));
}

/** Known excluded leaves are denied, rather than treated as unrecorded optional facts. */
export function blockedManifestPaths(manifest: ExposureManifest, readable: readonly string[]): string[] {
  const allowed = new Set(readable);
  return [...new Set([
    ...(manifest.paths ?? []).filter(entry => typeof entry.json_path === "string" &&
      (entry.exposure_eligibility === false || isInternalManifestPath(entry.json_path) ||
        entry.path_type === "leaf" && !allowed.has(entry.json_path))).map(entry => entry.json_path!),
    ...privateScopeRoots(manifest),
  ])].sort();
}
