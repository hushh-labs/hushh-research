import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";

export type PathDescriptor = {
  json_path: string;
  parent_path?: string | null;
  path_type: "object" | "array" | "leaf";
  exposure_eligibility: boolean;
  consent_label?: string | null;
  sensitivity_label?: string | null;
  segment_id?: string | null;
  scope_handle?: string | null;
  source_agent?: string | null;
};

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

function normalizePathSegment(segment: string): string {
  if (String(segment).trim().toLowerCase() === "_items") return "_items";
  return String(segment)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

function joinPath(parts: string[]): string {
  return parts.filter(Boolean).join(".");
}

function titleizePath(path: string): string {
  return path
    .split(".")
    .map((segment) => segment.replace(/_/g, " "))
    .join(" ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function cloneValue<T>(value: T): T {
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

function isExternalizablePath(path: string, pathType: PathDescriptor["path_type"]): boolean {
  if (pathType !== "leaf") return false;
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
  descriptors: Map<string, PathDescriptor>
): void {
  if (value === undefined) {
    return;
  }

  const pathKey = joinPath(path);
  if (pathKey) {
    const isArray = Array.isArray(value);
    const isObject =
      !!value && typeof value === "object" && !isArray;
    const sensitivityLabel = inferSensitivityLabel(pathKey);
    const pathType: PathDescriptor["path_type"] = isArray ? "array" : isObject ? "object" : "leaf";
    const nextDescriptor: PathDescriptor = {
      json_path: pathKey,
      parent_path: path.length > 1 ? joinPath(path.slice(0, -1)) : null,
      path_type: pathType,
      exposure_eligibility: isExternalizablePath(pathKey, pathType),
      consent_label: titleizePath(pathKey),
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
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined) {
        walkValue(item, [...path, "_items"], descriptors);
      }
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [rawKey, childValue] of Object.entries(record)) {
    const normalizedKey = normalizePathSegment(rawKey);
    if (!normalizedKey) {
      continue;
    }
    walkValue(childValue, [...path, normalizedKey], descriptors);
  }
}

export function buildPersonalKnowledgeModelStructureArtifacts(params: {
  domain: string;
  domainData: Record<string, unknown>;
  previousManifest?: DomainManifest | null;
}): {
  structureDecision: StructureDecision;
  manifest: DomainManifest;
} {
  const normalizedDomain = normalizePathSegment(params.domain) || "general";
  const descriptors = new Map<string, PathDescriptor>();
  walkValue(params.domainData, [], descriptors);

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
    return cloneValue(value);
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);
  if (segment === "_items") {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const extracted = value
      .map((item) => extractPathValue(item, rest))
      .filter((item) => item !== undefined);
    return extracted.length ? extracted : undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, segment)) {
    return undefined;
  }
  return extractPathValue(record[segment], rest);
}

function rebuildProjectedValue(segments: string[], value: unknown): unknown {
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
