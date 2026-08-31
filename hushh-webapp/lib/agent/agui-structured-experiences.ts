export const SCOPE_DISCOVERY_EXPERIENCE_TYPE = "one.scope_discovery.v1" as const;
export const INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE = "one.information_request_review.v1" as const;
export const KYC_READINESS_EXPERIENCE_TYPE = "one.kyc_readiness.v1" as const;
export const MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE = "one.memory_import_review.v1" as const;
export const EVIDENCE_BRIEF_EXPERIENCE_TYPE = "one.evidence_brief.v1" as const;

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

type ReviewField = {
  label: string;
  domain: string;
  sensitivity: ScopeDiscoverySensitivity;
};

export type InformationRequestReviewExperience = {
  type: typeof INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE;
  personName: string;
  purpose: string;
  durationLabel: string;
  status: "awaiting_review" | "pending" | "cancelled" | "granted" | "denied";
  fields: ReviewField[];
};

export type KycReadinessExperience = {
  type: typeof KYC_READINESS_EXPERIENCE_TYPE;
  subjectName: string;
  workflowName: string;
  summary: string;
  items: Array<ReviewField & { status: "available" | "ask_first" | "verify" | "not_available" }>;
  legalReviewRequired: boolean;
};

export type MemoryImportReviewExperience = {
  type: typeof MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE;
  sourceBlockCount: number;
  accountedBlockCount: number;
  groups: Array<{
    domain: string;
    candidates: Array<{
      candidateRef: string;
      label: string;
      preview: string;
      sensitivity: ScopeDiscoverySensitivity;
      sharingPosture: "private" | "ask_first" | "discoverable";
    }>;
  }>;
};

export type EvidenceBriefExperience = {
  type: typeof EVIDENCE_BRIEF_EXPERIENCE_TYPE;
  title: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  findings: Array<{ label: string; detail: string }>;
  sources: Array<{ label: string; url: string }>;
  unresolved: string[];
};

export type AgentStructuredExperience =
  | ScopeDiscoveryExperience
  | InformationRequestReviewExperience
  | KycReadinessExperience
  | MemoryImportReviewExperience
  | EvidenceBriefExperience;

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

function boundedInteger(value: unknown, max = 10_000): number | null {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max
    ? Number(value)
    : null;
}

function parseReviewFields(value: unknown, max = 100): ReviewField[] {
  return (Array.isArray(value) ? value.slice(0, max) : []).flatMap((item) => {
    const field = asRecord(item);
    const label = boundedString(field?.label, 120);
    const domain = boundedString(field?.domain, 80);
    if (!label || !domain) return [];
    return [{ label, domain, sensitivity: normalizeSensitivity(field?.sensitivity) }];
  });
}

function parseInformationRequestReview(content: unknown): InformationRequestReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const personName = boundedString(record.personName, 120);
  const purpose = boundedString(record.purpose, 500);
  const durationLabel = boundedString(record.durationLabel, 100);
  const status = boundedString(record.status, 32) as InformationRequestReviewExperience["status"] | null;
  if (!personName || !purpose || !durationLabel || !status || !["awaiting_review", "pending", "cancelled", "granted", "denied"].includes(status)) return null;
  return { type: INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE, personName, purpose, durationLabel, status, fields: parseReviewFields(record.fields) };
}

function parseKycReadiness(content: unknown): KycReadinessExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const subjectName = boundedString(record.subjectName, 120);
  const workflowName = boundedString(record.workflowName, 120);
  const summary = boundedString(record.summary, 500);
  if (!subjectName || !workflowName || !summary) return null;
  const items = (Array.isArray(record.items) ? record.items.slice(0, 100) : []).flatMap((item) => {
    const value = asRecord(item);
    const fields = parseReviewFields([value], 1);
    const status = boundedString(value?.status, 32) as KycReadinessExperience["items"][number]["status"] | null;
    if (!fields[0] || !status || !["available", "ask_first", "verify", "not_available"].includes(status)) return [];
    return [{ ...fields[0], status }];
  });
  return { type: KYC_READINESS_EXPERIENCE_TYPE, subjectName, workflowName, summary, items, legalReviewRequired: record.legalReviewRequired === true };
}

function parseMemoryImportReview(content: unknown): MemoryImportReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const sourceBlockCount = boundedInteger(record.sourceBlockCount);
  const accountedBlockCount = boundedInteger(record.accountedBlockCount);
  if (sourceBlockCount === null || accountedBlockCount === null || accountedBlockCount > sourceBlockCount) return null;
  const groups = (Array.isArray(record.groups) ? record.groups.slice(0, 50) : []).flatMap((rawGroup) => {
    const group = asRecord(rawGroup);
    const domain = boundedString(group?.domain, 80);
    if (!domain) return [];
    const candidates = (Array.isArray(group?.candidates) ? group.candidates.slice(0, 250) : []).flatMap((rawCandidate) => {
      const candidate = asRecord(rawCandidate);
      const candidateRef = boundedString(candidate?.candidateRef, 180);
      const label = boundedString(candidate?.label, 120);
      const preview = boundedString(candidate?.preview, 280);
      const sharingPosture = boundedString(candidate?.sharingPosture, 32) as MemoryImportReviewExperience["groups"][number]["candidates"][number]["sharingPosture"] | null;
      if (!candidateRef || !label || !preview || !sharingPosture || !["private", "ask_first", "discoverable"].includes(sharingPosture)) return [];
      return [{ candidateRef, label, preview, sharingPosture, sensitivity: normalizeSensitivity(candidate?.sensitivity) }];
    });
    return [{ domain, candidates }];
  });
  return { type: MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE, sourceBlockCount, accountedBlockCount, groups };
}

function parseEvidenceBrief(content: unknown): EvidenceBriefExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const title = boundedString(record.title, 160);
  const summary = boundedString(record.summary, 800);
  const confidence = boundedString(record.confidence, 16) as EvidenceBriefExperience["confidence"] | null;
  if (!title || !summary || !confidence || !["high", "medium", "low"].includes(confidence)) return null;
  const findings = (Array.isArray(record.findings) ? record.findings.slice(0, 30) : []).flatMap((item) => {
    const finding = asRecord(item);
    const label = boundedString(finding?.label, 120);
    const detail = boundedString(finding?.detail, 500);
    return label && detail ? [{ label, detail }] : [];
  });
  const sources = (Array.isArray(record.sources) ? record.sources.slice(0, 20) : []).flatMap((item) => {
    const source = asRecord(item);
    const label = boundedString(source?.label, 160);
    const url = boundedString(source?.url, 500);
    if (!label || !url || !/^https:\/\//i.test(url)) return [];
    return [{ label, url }];
  });
  const unresolved = (Array.isArray(record.unresolved) ? record.unresolved.slice(0, 20) : []).flatMap((item) => {
    const value = boundedString(item, 280);
    return value ? [value] : [];
  });
  return { type: EVIDENCE_BRIEF_EXPERIENCE_TYPE, title, summary, confidence, findings, sources, unresolved };
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
  [INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE]: parseInformationRequestReview,
  [KYC_READINESS_EXPERIENCE_TYPE]: parseKycReadiness,
  [MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE]: parseMemoryImportReview,
  [EVIDENCE_BRIEF_EXPERIENCE_TYPE]: parseEvidenceBrief,
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
