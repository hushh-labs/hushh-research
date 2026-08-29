export const SCOPE_DISCOVERY_EXPERIENCE_TYPE = "one.scope_discovery.v1" as const;

const MAX_SCOPES = 250;
const PROFILE_PATH_PATTERN = /^\/people\/[A-Za-z0-9_-]{16,128}$/;

export type ScopeDiscoverySensitivity =
  | "standard"
  | "sensitive"
  | "restricted";

export type ScopeDiscoveryItem = {
  scopeRef: string;
  label: string;
  description: string | null;
  domain: string;
  sensitivity: ScopeDiscoverySensitivity;
};

export type ScopeDiscoveryExperience = {
  type: typeof SCOPE_DISCOVERY_EXPERIENCE_TYPE;
  person: {
    displayName: string;
    profilePath: string;
    relationship: string | null;
  };
  domainFilter: string | null;
  scopes: ScopeDiscoveryItem[];
};

export type AgentStructuredExperience = ScopeDiscoveryExperience;

type ExperienceParser = (
  content: unknown,
) => AgentStructuredExperience | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function unwrapToolResult(value: unknown): Record<string, unknown> | null {
  const record = parseRecord(value);
  if (!record) return null;

  for (const key of ["result", "content", "data"] as const) {
    const nested = parseRecord(record[key]);
    if (nested?.status || nested?.requestableScopes) return nested;
  }
  return record;
}

function normalizeSensitivity(value: unknown): ScopeDiscoverySensitivity {
  const normalized = boundedString(value, 32)?.toLowerCase();
  if (normalized === "restricted" || normalized === "high") {
    return "restricted";
  }
  if (normalized === "sensitive" || normalized === "medium") {
    return "sensitive";
  }
  return "standard";
}

function parseScopeDiscovery(
  content: unknown,
): ScopeDiscoveryExperience | null {
  const record = unwrapToolResult(content);
  if (!record || record.status !== "ok") return null;

  const person = asRecord(record.person);
  const displayName = boundedString(person?.displayName, 120);
  const profilePath = boundedString(person?.profilePath, 180);
  if (
    !person ||
    !displayName ||
    !profilePath ||
    !PROFILE_PATH_PATTERN.test(profilePath)
  ) {
    return null;
  }

  const rawScopes = Array.isArray(record.requestableScopes)
    ? record.requestableScopes.slice(0, MAX_SCOPES)
    : [];
  const scopes = rawScopes.flatMap<ScopeDiscoveryItem>((rawScope) => {
    const scope = asRecord(rawScope);
    const scopeRef = boundedString(scope?.scopeRef, 180);
    const label = boundedString(scope?.label, 120);
    const domain = boundedString(scope?.domain, 80);
    if (!scope || !scopeRef || !label || !domain) return [];
    return [
      {
        scopeRef,
        label,
        description: boundedString(scope.description, 280),
        domain,
        sensitivity: normalizeSensitivity(scope.sensitivity),
      },
    ];
  });

  return {
    type: SCOPE_DISCOVERY_EXPERIENCE_TYPE,
    person: {
      displayName,
      profilePath,
      relationship: boundedString(person.relationship, 64),
    },
    domainFilter: boundedString(record.domainFilter, 80),
    scopes,
  };
}

const EXPERIENCE_REGISTRY: Record<string, ExperienceParser> = {
  [SCOPE_DISCOVERY_EXPERIENCE_TYPE]: parseScopeDiscovery,
};

export function parseAgentActivityExperience(
  activityType: string,
  content: unknown,
): AgentStructuredExperience | null {
  const parser = EXPERIENCE_REGISTRY[activityType];
  return parser ? parser(content) : null;
}

export function parseAgentToolResultExperience(
  toolName: string,
  content: unknown,
): AgentStructuredExperience | null {
  if (toolName !== "discover_person_information") return null;
  return parseScopeDiscovery(content);
}
