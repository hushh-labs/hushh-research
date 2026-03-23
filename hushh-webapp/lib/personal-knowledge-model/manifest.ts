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

export type DomainManifest = {
  user_id?: string;
  domain: string;
  manifest_version: number;
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
  scope_registry?: Array<{
    scope_handle: string;
    scope_label: string;
    segment_ids: string[];
    sensitivity_tier?: string;
    scope_kind?: string;
    exposure_enabled?: boolean;
    summary_projection?: Record<string, unknown>;
  }>;
};

function normalizePathSegment(segment: string): string {
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
    descriptors.set(pathKey, {
      json_path: pathKey,
      parent_path: path.length > 1 ? joinPath(path.slice(0, -1)) : null,
      path_type: isArray ? "array" : isObject ? "object" : "leaf",
      exposure_eligibility: true,
      consent_label: titleizePath(pathKey),
      sensitivity_label: sensitivityLabel,
      segment_id: path[0] || "root",
      source_agent: "pkm_structure_agent",
    });
  }

  if (Array.isArray(value)) {
    const sample = value.find((item) => item !== undefined && item !== null);
    if (sample !== undefined) {
      walkValue(sample, [...path, "_items"], descriptors);
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
    .filter((path) => path.exposure_eligibility)
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
  const summaryProjection = {
    manifest_version: nextManifestVersion,
    path_count: jsonPaths.length,
    externalizable_path_count: externalizablePaths.length,
    top_level_scope_count: topLevelScopePaths.length,
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

export function projectDomainDataForScope(params: {
  domain: string;
  scope: string;
  domainData: Record<string, unknown>;
}): Record<string, unknown> {
  if (
    params.scope === "pkm.read" ||
    params.scope === `attr.${params.domain}.*`
  ) {
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

  if (!normalizedPath) {
    return { [params.domain]: cloneValue(params.domainData) };
  }

  const segments = normalizedPath.split(".");
  const extracted = extractPathValue(params.domainData, segments);
  if (extracted === undefined) {
    return { [params.domain]: {} };
  }

  return {
    [params.domain]: rebuildProjectedValue(segments, extracted) as Record<string, unknown>,
  };
}

export const projectPersonalKnowledgeModelDataForScope = projectDomainDataForScope;
