import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import { humanizeMemoryPath } from "@/lib/pkm/humanize-segment";

export type PathDescriptor = {
  json_path: string;
  parent_path?: string | null;
  path_type: "object" | "array" | "leaf";
  exposure_eligibility: boolean;
  /**
   * This path's own final segment, as the owner's data actually spelled it.
   *
   * `json_path` is normalized for authorization and is therefore lowercased,
   * which destroys the word boundary in a key like `addressDetails`. That loss
   * is irreversible: no downstream function can tell `addressdetails` from a
   * genuine single word. Keeping the original segment here is what lets any
   * consumer render one level of the path in the owner's own words.
   *
   * Null for the synthetic collection segments (`_items`, `_entities`), which
   * were never keys the owner wrote.
   */
  display_segment?: string | null;
  consent_label?: string | null;
  sensitivity_label?: string | null;
  segment_id?: string | null;
  scope_handle?: string | null;
  source_agent?: string | null;
};

export class PkmMetadataReviewRequired extends Error {
  constructor() {
    super("Memory metadata needs review before saving.");
    this.name = "PkmMetadataReviewRequired";
  }
}

export type StructureDecision = {
  action: "match_existing_domain" | "create_domain" | "extend_domain";
  target_domain: string;
  json_paths: string[];
  top_level_scope_paths: string[];
  externalizable_paths: string[];
  summary_projection: Record<string, unknown>;
  sensitivity_labels: Record<string, string>;
  confidence: number;
  source_agent: string;
  contract_version: number;
};

export type PkmScopeRegistryEntry = {
  scope_handle: string;
  scope_label: string;
  segment_ids: string[];
  sensitivity_tier?: string;
  scope_kind?: string;
  scope_origin?: "dynamic" | "reserved";
  scope_origin_code?: "d" | "r";
  source_kind?: "manifest_branch" | "reserved_registry";
  exposure_enabled?: boolean;
  visibility_posture?: "private" | "consent_required";
  default_projection_ready?: boolean;
  default_projection_updated_at?: string | null;
  owner_consent_override?: boolean;
  summary_projection?: Record<string, unknown> & {
    top_level_scope_path?: string;
    materialization_state?: "materialized" | "empty" | "unknown";
    materialized_leaf_count?: number;
    source_manifest_revision?: number;
    consumer_visible?: boolean;
    internal_only?: boolean;
    visibility_reason?: string;
    storage_mode?: string;
  };
};

export type PkmScopeMaterialization = {
  state: "materialized" | "empty" | "unknown";
  materialized_leaf_count: number;
};

export type DomainManifest = {
  user_id?: string;
  domain: string;
  manifest_version: number;
  domain_contract_version?: number;
  pkm_contract_version?: string;
  readable_summary_version?: number;
  readable_projection_version?: string;
  latest_upgrade_commit_id?: string | null;
  upgraded_at?: string | null;
  structure_decision?: Record<string, unknown>;
  summary_projection: Record<string, unknown>;
  top_level_scope_paths: string[];
  externalizable_paths: string[];
  segment_ids?: string[];
  path_count?: number;
  externalizable_path_count?: number;
  last_structured_at?: string | null;
  last_content_at?: string | null;
  paths: PathDescriptor[];
  scope_registry?: PkmScopeRegistryEntry[];
};

/** The key whose children are a collection keyed by entity id, not structure. */
const ENTITY_MAP_KEY = "entities";
/** One representative subtree standing for every entry of an `entities` map. */
const ENTITY_COLLECTION_SEGMENT = "_entities";
/** The Financial contract stores one analysis-history array per ticker. */
const ANALYSIS_HISTORY_MAP_KEY = "analysis_history";

function normalizePathSegment(segment: string): string {
  const normalized = String(segment).trim().toLowerCase();
  // Synthetic collection segments survive verbatim; the rule below would strip
  // their leading underscore and turn them into ordinary keys.
  if (normalized === "_items") return "_items";
  if (normalized === ENTITY_COLLECTION_SEGMENT) return ENTITY_COLLECTION_SEGMENT;
  // Private-key spelling is authority-bearing. Never turn `_private` into an
  // ordinary public path while preparing a manifest or resolving one.
  if (normalized.startsWith("_")) return normalized;
  return String(segment)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

function joinPath(parts: string[]): string {
  return parts.filter(Boolean).join(".");
}

/**
 * The owner-facing label for a path, built from the segments AS WRITTEN.
 *
 * This must be called with the raw path, never the normalized one. The
 * normalized path has already been lowercased for authorization, and the words
 * cannot be recovered from it: that is exactly how a chat row came to read
 * "Saved Places Locations Items Addressdetails Buildingcolor". The shared
 * resolver handles camelCase, letter-to-digit runs and separators; a caller
 * that hands it `addressdetails` gets "Addressdetails", correctly, because by
 * then the information is gone.
 */
function titleizePath(path: string): string {
  return humanizeMemoryPath(path);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to JSON clone.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function inferSensitivityLabel(path: string): string | null {
  const normalized = path.toLowerCase();
  if (
    normalized.includes("ssn") ||
    normalized.includes("tax") ||
    normalized.includes("account_number") ||
    normalized.includes("routing")
  ) {
    return "restricted";
  }
  if (
    normalized.includes("risk") ||
    normalized.includes("holdings") ||
    normalized.includes("portfolio") ||
    normalized.includes("income")
  ) {
    return "confidential";
  }
  return null;
}

const BLOCKED_EXTERNAL_PATH_PARTS = new Set([
  "changes",
  "created_at",
  "debug",
  "debug_fields",
  "entity_id",
  "hash",
  "metadata",
  "parser_metadata",
  "provenance",
  "schema_version",
  "source_agent",
  "timestamps",
  "updated_at",
  "workflow",
  "workflow_id",
  "workflow_state",
]);

/**
 * The sealed Plaid tiers (see `lib/kai/plaid-vault/types.ts`). Private to the
 * owner, never offered for sharing (the shareable tier is `summary`), so the
 * manifest declares each as one opaque node and does not walk inside it.
 *
 * Walked field by field they grew with the records: one bank's 264
 * transactions declared 3,349 paths, and even collapsed they cost ~190 of the
 * 1000 `json_paths` a domain may declare. A real account already spent 821 on
 * statements and the older Plaid copy, so the sealed connect write died with a
 * 422 (iPhone proof, run 13). Nothing reads a path below these roots.
 */
const VAULT_PRIVATE_BRANCHES = new Set([
  "connections_v1",
  "accounts_v1",
  "holdings_v1",
  "securities_v1",
  "transactions_v1",
  "derived_v1",
]);

/** Segments the walk invents; they were never keys the owner wrote. */
const SYNTHETIC_SEGMENTS = new Set(["_items", ENTITY_COLLECTION_SEGMENT]);

function isExternalizablePath(
  path: string,
  pathType: PathDescriptor["path_type"],
  value: unknown,
): boolean {
  if (pathType !== "leaf") return false;
  if (VAULT_PRIVATE_BRANCHES.has(path.split(".")[0] ?? "")) return false;

  // A value nobody ever set is not information about anybody.
  //
  // This returned true for `null`, so `nav_skipped_at: null` -- a thing that
  // never happened -- became a requestable scope. kai-profile-service
  // initialises a dozen such fields to null at :181-196, which is a large part
  // of how one person's finance catalogue reached fifty rows. `countMaterializedLeaves`
  // above has always treated null as zero; this now agrees with it.
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && !value.trim()) return false;

  // Plumbing, at any depth. BLOCKED_EXTERNAL_PATH_PARTS stays as the
  // write-time list it always was; the shared contract adds the app-state
  // shapes it never covered -- setup checkpoints, nested domain_intent, and the
  // *_selected_at / *_anchor_at timestamps that listed beside the answers they
  // timestamp and read as duplicates.
  // Synthetic segments are exempt. `_entities` and `_items` are invented by
  // this walk, not written by the owner (see SYNTHETIC_SEGMENTS), so the
  // leading-underscore convention -- which means "the OWNER marked this
  // private" -- does not apply to them. Without this carve-out the filter ate
  // every entity-collapsed holding, which manifest-entity-collapse caught
  // immediately: exactly the job of the half of these tests that assert what
  // must survive.
  const ownerWrittenPath = path
    .split(".")
    .filter((segment) => !SYNTHETIC_SEGMENTS.has(segment))
    .join(".");
  if (ownerWrittenPath && isInternalManifestPath(ownerWrittenPath)) return false;

  return !path.split(".").some((part) => BLOCKED_EXTERNAL_PATH_PARTS.has(part));
}

function countMaterializedLeaves(value: unknown, path: string[] = []): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.trim().length > 0 ? 1 : 0;
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + countMaterializedLeaves(item, [...path, "_items"]),
      0
    );
  }
  if (typeof value !== "object") return 0;

  return Object.entries(value as Record<string, unknown>).reduce((count, [rawKey, child]) => {
    const normalizedKey = normalizePathSegment(rawKey);
    if (!normalizedKey || BLOCKED_EXTERNAL_PATH_PARTS.has(normalizedKey)) return count;
    return count + countMaterializedLeaves(child, [...path, normalizedKey]);
  }, 0);
}

function countEntityMaps(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countEntityMaps(item), 0);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const [key, child] of Object.entries(record)) {
    if (key === "entities" && child && typeof child === "object" && !Array.isArray(child)) {
      count += Object.keys(child as Record<string, unknown>).length;
      continue;
    }
    count += countEntityMaps(child);
  }
  return count;
}


function walkValue(
  value: unknown,
  path: string[],
  descriptors: Map<string, PathDescriptor>,
  /**
   * The same path, segment for segment, spelled as the owner's data spells it.
   *
   * Carried alongside `path` rather than derived from it, because `path` has
   * been through `normalizePathSegment` and the word boundaries are already
   * gone. This is the only point in the system where both forms exist at once,
   * which is why the label has to be authored here and not at any of the five
   * places downstream that used to try.
   */
  displayPath: string[],
  metadataPaths?: Map<string, { path: string; defaultLabel: string }>,
  concretePath: string[] = path,
  concreteDisplayPath: string[] = displayPath
): void {
  if (value === undefined) {
    return;
  }

  const pathKey = joinPath(path);
  if (pathKey) {
    metadataPaths?.set(joinPath(concretePath), {
      path: pathKey, defaultLabel: titleizePath(joinPath(concreteDisplayPath)),
    });
    const rawSegment = displayPath[displayPath.length - 1] ?? "";
    const isArray = Array.isArray(value);
    const isObject =
      !!value && typeof value === "object" && !isArray;
    const sensitivityLabel = inferSensitivityLabel(pathKey);
    const pathType: PathDescriptor["path_type"] = isArray ? "array" : isObject ? "object" : "leaf";
    const nextDescriptor: PathDescriptor = {
      json_path: pathKey,
      parent_path: path.length > 1 ? joinPath(path.slice(0, -1)) : null,
      path_type: pathType,
      exposure_eligibility: isExternalizablePath(pathKey, pathType, value),
      display_segment: SYNTHETIC_SEGMENTS.has(rawSegment) ? null : rawSegment || null,
      consent_label: titleizePath(joinPath(displayPath)),
      sensitivity_label: sensitivityLabel,
      segment_id: path[0] || "root",
      source_agent: "pkm_structure_agent",
    };
    const existingDescriptor = descriptors.get(pathKey);
    if (!existingDescriptor) {
      descriptors.set(pathKey, nextDescriptor);
    } else if (existingDescriptor.path_type !== nextDescriptor.path_type) {
      // A heterogeneous array can contain scalar, object, and array values at
      // the same logical `_items` path. The manifest contract has one path type,
      // so retain the safest container type and never expose the ambiguous
      // container itself. Descendant paths from every item are still recorded.
      const typeRank: Record<PathDescriptor["path_type"], number> = {
        leaf: 0,
        object: 1,
        array: 2,
      };
      descriptors.set(pathKey, {
        ...existingDescriptor,
        path_type:
          typeRank[nextDescriptor.path_type] > typeRank[existingDescriptor.path_type]
            ? nextDescriptor.path_type
            : existingDescriptor.path_type,
        exposure_eligibility: false,
      });
    } else {
      // Collection walks are intentionally order-independent. A null, empty,
      // or otherwise non-materialized occurrence must not hide a populated
      // sibling that resolves to the same logical path later in the array or
      // entity map. Keep the first safe presentation metadata, but union the
      // independently computed eligibility/materialization signal.
      descriptors.set(pathKey, {
        ...existingDescriptor,
        exposure_eligibility:
          existingDescriptor.exposure_eligibility || nextDescriptor.exposure_eligibility,
        consent_label: existingDescriptor.consent_label || nextDescriptor.consent_label,
        sensitivity_label:
          existingDescriptor.sensitivity_label || nextDescriptor.sensitivity_label,
      });
    }
  }

  if (path.length === 1 && VAULT_PRIVATE_BRANCHES.has(path[0] ?? "")) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined) {
        walkValue(item, [...path, "_items"], descriptors, [...displayPath, "_items"], metadataPaths, [...concretePath, "_items"], [...concreteDisplayPath, "_items"]);
      }
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  // An `entities` map is a homogeneous collection keyed by entity id -- the
  // same shape as an array, just keyed. Financial analysis history has the
  // same shape one level earlier: its ticker keys each contain an array of
  // history entries, alongside a domain_intent metadata object. Walking each
  // key made the manifest grow with the DATA rather than the SHAPE: a real
  // reviewer portfolio emitted 1,043 paths, pushed the request past the
  // server's 1000-path cap, and the save died with a 422. Collapse only the
  // collection entries and continue walking metadata siblings normally.
  const mapKey = path[path.length - 1];
  const isAnalysisHistoryMap =
    mapKey === ANALYSIS_HISTORY_MAP_KEY &&
    Object.values(record).some((childValue) => Array.isArray(childValue));
  if (mapKey === ENTITY_MAP_KEY || isAnalysisHistoryMap) {
    for (const [rawKey, childValue] of Object.entries(record)) {
      if (childValue === undefined || rawKey.trim().startsWith("_")) continue;
      // `domain_intent` is metadata on the analysis-history map, not an
      // entity. Keep its authored path so it remains available to internal
      // reconciliation while ticker entries share one safe descriptor tree.
      if (isAnalysisHistoryMap && !Array.isArray(childValue)) {
        const normalizedKey = normalizePathSegment(rawKey);
        if (normalizedKey) {
          walkValue(childValue, [...path, normalizedKey], descriptors, [...displayPath, rawKey], metadataPaths, [...concretePath, normalizedKey], [...concreteDisplayPath, rawKey]);
        }
        continue;
      }
      walkValue(childValue, [...path, ENTITY_COLLECTION_SEGMENT], descriptors, [
        ...displayPath,
        ENTITY_COLLECTION_SEGMENT,
      ], metadataPaths, [...concretePath, normalizePathSegment(rawKey)], [...concreteDisplayPath, rawKey]);
    }
    return;
  }
  for (const [rawKey, childValue] of Object.entries(record)) {
    const normalizedKey = normalizePathSegment(rawKey);
    if (!normalizedKey) {
      continue;
    }
    // rawKey, not normalizedKey: this is the moment the spelling still exists.
    walkValue(childValue, [...path, normalizedKey], descriptors, [...displayPath, rawKey], metadataPaths, [...concretePath, normalizedKey], [...concreteDisplayPath, rawKey]);
  }
}

export function buildPersonalKnowledgeModelStructureArtifacts(params: {
  domain: string;
  domainData: Record<string, unknown>;
  previousManifest?: DomainManifest | null;
  /** Oldest first; metadata only, never path/exposure authority. */
  semanticManifests?: DomainManifest[];
  semanticDecision?: Record<string, unknown>;
}): {
  structureDecision: StructureDecision;
  manifest: DomainManifest;
} {
  const normalizedDomain = normalizePathSegment(params.domain) || "general";
  const descriptors = new Map<string, PathDescriptor>();
  const metadataPaths = new Map<string, { path: string; defaultLabel: string }>();
  walkValue(params.domainData, [], descriptors, [], metadataPaths);

  const resolveMetadataPath = (path: string) => descriptors.get(path)
    ?? descriptors.get(metadataPaths.get(path)?.path || "");
  // Apply revisions at the source path before combining collection members.
  const sensitivityBySource = new Map<string, { target: PathDescriptor; label: string }>();
  const applyMetadata = (
    target: PathDescriptor, field: "consent_label" | "sensitivity_label",
    value: unknown, seen: Map<string, string>,
  ) => {
    if (typeof value !== "string" || !value.trim()) return;
    const key = `${target.json_path}:${field}`;
    const label = value.trim();
    if (seen.has(key) && seen.get(key) !== label) {
      // Different entity assessments cannot be represented by one collection
      // label. Preserve the draft for review instead of selecting the last one.
      throw new PkmMetadataReviewRequired();
    }
    seen.set(key, label);
    target[field] = label;
  };

  for (const manifest of params.semanticManifests || []) {
    if (manifest.domain !== normalizedDomain) continue;
    const seen = new Map<string, string>();
    for (const source of manifest.paths) {
      const target = resolveMetadataPath(source.json_path);
      if (!target || target.path_type !== source.path_type) continue;
      for (const field of ["consent_label", "sensitivity_label"] as const) {
        const value = source[field];
        if (field === "consent_label" && target.json_path !== source.json_path
          && typeof value === "string" && value.trim()) {
          if (value.trim() !== metadataPaths.get(source.json_path)?.defaultLabel) {
            throw new PkmMetadataReviewRequired();
          }
          // A concrete default title is not a collection label. Preserve the
          // canonical collection title without publishing an entity identifier.
          continue;
        }
        if (field === "sensitivity_label") {
          if (typeof value === "string" && value.trim()) {
            sensitivityBySource.set(source.json_path, { target, label: value.trim() });
          }
        } else applyMetadata(target, field, value, seen);
      }
    }
  }
  const decision = params.semanticDecision;
  const labels = decision?.target_domain === normalizedDomain ? decision.sensitivity_labels : null;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [path, label] of Object.entries(labels)) {
      const target = resolveMetadataPath(path);
      if (target && typeof label === "string" && label.trim()) {
        sensitivityBySource.set(path, { target, label: label.trim() });
      }
    }
  }
  const sensitivitySeen = new Map<string, string>();
  for (const { target, label } of sensitivityBySource.values()) {
    applyMetadata(target, "sensitivity_label", label, sensitivitySeen);
  }

  const paths = [...descriptors.values()].sort((a, b) =>
    a.json_path.localeCompare(b.json_path)
  );
  const jsonPaths = paths.map((path) => path.json_path);
  const externalizablePaths = paths
    .filter((path) => path.exposure_eligibility && path.path_type === "leaf")
    .map((path) => path.json_path);
  const topLevelScopePaths = [
    ...new Set(
      paths
        .map((path) => path.json_path.split(".")[0])
        .filter((path): path is string => typeof path === "string" && path.length > 0)
    ),
  ];
  const previousPaths = new Set((params.previousManifest?.paths || []).map((path) => path.json_path));
  const hasNewPaths = jsonPaths.some((path) => !previousPaths.has(path));
  const action: StructureDecision["action"] = !params.previousManifest
    ? "create_domain"
    : hasNewPaths
      ? "extend_domain"
      : "match_existing_domain";

  const sensitivityLabels = Object.fromEntries(
    paths
      .filter((path) => path.sensitivity_label)
      .map((path) => [path.json_path, path.sensitivity_label as string])
  );
  const nextManifestVersion = Math.max(1, params.previousManifest?.manifest_version || 0) + (
    action === "match_existing_domain" ? 0 : 1
  );
  const scopeMaterialization: Record<string, PkmScopeMaterialization> = {};
  for (const [rawScope, value] of Object.entries(params.domainData)) {
    const scope = normalizePathSegment(rawScope);
    if (!scope || BLOCKED_EXTERNAL_PATH_PARTS.has(scope)) continue;
    const materializedLeafCount = countMaterializedLeaves(value, [scope]);
    scopeMaterialization[scope] = {
      state: materializedLeafCount > 0 ? "materialized" : "empty",
      materialized_leaf_count: materializedLeafCount,
    };
  }
  const summaryProjection = {
    manifest_version: nextManifestVersion,
    domain_contract_version: currentDomainContractVersion(normalizedDomain),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    consumer_visible: true,
    internal_only: false,
    consumer_item_count: countEntityMaps(params.domainData) || undefined,
    path_count: jsonPaths.length,
    externalizable_path_count: externalizablePaths.length,
    top_level_scope_count: topLevelScopePaths.length,
    scope_materialization: scopeMaterialization,
  };

  const structureDecision: StructureDecision = {
    action,
    target_domain: normalizedDomain,
    json_paths: jsonPaths,
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    summary_projection: summaryProjection,
    sensitivity_labels: sensitivityLabels,
    confidence: 1,
    source_agent: "pkm_structure_agent",
    contract_version: 1,
  };

  const nowIso = new Date().toISOString();
  const manifest: DomainManifest = {
    domain: normalizedDomain,
    manifest_version: nextManifestVersion,
    domain_contract_version: currentDomainContractVersion(normalizedDomain),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    upgraded_at: null,
    structure_decision: structureDecision,
    summary_projection: summaryProjection,
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    segment_ids: [...new Set(paths.map((path) => path.segment_id || "root"))],
    path_count: jsonPaths.length,
    externalizable_path_count: externalizablePaths.length,
    last_structured_at: nowIso,
    last_content_at: nowIso,
    paths,
  };

  return {
    structureDecision,
    manifest,
  };
}

function extractPathValue(value: unknown, segments: string[]): unknown {
  if (!segments.length) {
    // An eligible leaf may have changed since review. Never export a newly
    // introduced subtree under authority that described a scalar field.
    if (value !== null && typeof value === "object") return undefined;
    return cloneValue(value);
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);
  if (segment === "_items") {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const extracted = value.map((item) => extractPathValue(item, rest));
    // Preserve slots until all selected paths have been merged. Compacting
    // each column separately can attach one item's field to another item.
    return extracted.some(item => item !== undefined) ? extracted : undefined;
  }
  if (segment === ENTITY_COLLECTION_SEGMENT) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    // One collapsed path stands for every entity, so project each one and keep
    // the entity ids as keys -- the manifest no longer enumerates them, but the
    // projected data still has to say which entity each value belongs to.
    const extracted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.trim().startsWith("_")) continue;
      const child = extractPathValue(item, rest);
      if (child !== undefined) {
        extracted[key] = child;
      }
    }
    return Object.keys(extracted).length ? extracted : undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  // The manifest uses canonical spelling; encrypted records retain the
  // original spelling. This is the same codec as the manifest walk, not a
  // semantic alias. Collisions are ambiguous even if one key is an exact hit.
  const keys = Object.keys(record).filter(key => normalizePathSegment(key) === segment);
  if (keys.length !== 1 || keys[0]!.trim().startsWith("_")) return undefined;
  return extractPathValue(record[keys[0]!], rest);
}

function rebuildProjectedValue(segments: string[], value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!segments.length) {
    return cloneValue(value);
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);
  if (segment === "_items") {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => rebuildProjectedValue(rest, item));
  }
  if (segment === ENTITY_COLLECTION_SEGMENT) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    // Mirrors the keyed shape extractPathValue produced for this segment.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        rebuildProjectedValue(rest, item),
      ]),
    );
  }

  return {
    [segment]: rebuildProjectedValue(rest, value),
  };
}

function mergeProjectedValues(current: unknown, next: unknown): unknown {
  if (Array.isArray(current) && Array.isArray(next)) {
    const length = Math.max(current.length, next.length);
    return Array.from({ length }, (_, index) => {
      if (current[index] === undefined) return cloneValue(next[index]);
      if (next[index] === undefined) return cloneValue(current[index]);
      return mergeProjectedValues(current[index], next[index]);
    });
  }
  if (
    current &&
    next &&
    typeof current === "object" &&
    typeof next === "object" &&
    !Array.isArray(current) &&
    !Array.isArray(next)
  ) {
    const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      merged[key] = key in merged ? mergeProjectedValues(merged[key], value) : cloneValue(value);
    }
    return merged;
  }
  return cloneValue(next);
}

export function projectDomainDataForScope(params: {
  domain: string;
  scope: string;
  domainData: Record<string, unknown>;
  approvedPaths?: string[];
}): Record<string, unknown> {
  if (params.scope === "pkm.read") {
    return { [params.domain]: cloneValue(params.domainData) };
  }

  const prefix = `attr.${params.domain}.`;
  if (!params.scope.startsWith(prefix)) {
    return { [params.domain]: {} };
  }

  const rawPath = params.scope.slice(prefix.length).replace(/\.\*$/, "");
  const normalizedPath = rawPath
    .split(".")
    .map((segment) => normalizePathSegment(segment))
    .filter(Boolean)
    .join(".");

  const approvedPaths = (params.approvedPaths || [])
    .map((path) =>
      String(path || "")
        .split(".")
        .map((segment) => normalizePathSegment(segment))
        .filter(Boolean)
        .join(".")
    )
    .filter(Boolean)
    .filter(
      (path) => !normalizedPath || path === normalizedPath || path.startsWith(`${normalizedPath}.`)
    );
  if (approvedPaths.length === 0) {
    return { [params.domain]: {} };
  }

  let projected: unknown = {};
  for (const approvedPath of approvedPaths) {
    const segments = approvedPath.split(".");
    const extracted = extractPathValue(params.domainData, segments);
    if (extracted === undefined) continue;
    projected = mergeProjectedValues(projected, rebuildProjectedValue(segments, extracted));
  }
  return {
    [params.domain]: projected as Record<string, unknown>,
  };
}

export const projectPersonalKnowledgeModelDataForScope = projectDomainDataForScope;
