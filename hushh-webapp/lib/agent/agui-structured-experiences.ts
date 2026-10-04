import type { PersonScopeCatalog } from "@/lib/services/person-profile-service";
import { parseScopeProposal, type ScopeProposal } from "./scope-proposal";
import { parseSharedFieldSensitivities, type SharedFieldSensitivity } from "@/lib/consent/field-sensitivity";
import {
  parseConnectorReadReceipt,
  parseWorkspaceConnectorSetup,
  parseWorkspaceConnectorSetupDescriptor,
  WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE,
  type ConnectorReadExperience,
  type WorkspaceConnectorSetupExperience,
} from "./connector-read-receipt";
import { parseCustomConnectorProbe, type CustomConnectorProbeExperience } from "./custom-connector-probe";
import { parseOwnerStyleProposal, type OwnerStyleProposal } from "./owner-style-settings";

export const SCOPE_DISCOVERY_EXPERIENCE_TYPE = "one.scope_discovery.v1" as const;
export const PERSON_SELECTION_EXPERIENCE_TYPE = "one.person_selection.v1" as const;
export type PersonSelectionSourceTool =
  | "discover_person_information"
  | "propose_information_request"
  | "propose_document_request"
  | "propose_drive_share"
  | "list_information_shared_with_me";
export type PersonSelectionExperience = {
  type: typeof PERSON_SELECTION_EXPERIENCE_TYPE;
  /** The structured tool that asked for the choice; the prompt follows it. */
  sourceTool: PersonSelectionSourceTool;
  candidates: Array<{ selectionHandle: string; personRef: string; displayName: string; profilePath: string; detail: string | null }>;
  candidatesIncomplete?: boolean;
};
export const INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE = "one.information_request_review.v1" as const;
export const DOCUMENT_REQUEST_REVIEW_EXPERIENCE_TYPE = "one.document_request_review.v1" as const;
export const DRIVE_SHARE_REVIEW_EXPERIENCE_TYPE = "one.drive_share_review.v1" as const;
export const DRIVE_BULK_SHARE_REVIEW_EXPERIENCE_TYPE = "one.drive_bulk_share_review.v1" as const;
export const KYC_READINESS_EXPERIENCE_TYPE = "one.kyc_readiness.v1" as const;
export const MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE = "one.memory_import_review.v1" as const;
export const EVIDENCE_BRIEF_EXPERIENCE_TYPE = "one.evidence_brief.v1" as const;
export const STYLE_SETTINGS_OFFER_EXPERIENCE_TYPE = "one.style_settings_offer.v1" as const;

/**
 * One's offer to change how it writes to the owner. It names the proposed
 * values and only opens Settings; the owner saves there, with the Settings
 * writer. Chat never writes the reserved style branch.
 */
export type StyleSettingsOfferExperience = {
  type: typeof STYLE_SETTINGS_OFFER_EXPERIENCE_TYPE;
  proposed: OwnerStyleProposal;
};

/**
 * The follow-up sent after a person is picked. It is chosen from the tool that
 * produced the picker, never from conversation words: discovery keeps its
 * catalog prompt, and every other tool gets a neutral choice so the private
 * agent carries on with the request it was making.
 */
export function personSelectionPrompt(sourceTool: PersonSelectionSourceTool, name: string): string {
  return sourceTool === "discover_person_information"
    ? `Check what I can ask ${name} for.`
    : `I mean ${name}.`;
}

const MAX_SCOPES = 250;
const PROFILE_PATH_PATTERN = /^\/people\/[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_PERSON_REF_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A turn may carry an authored card and a short prose note. This role is
 * explicit so the client never guesses by comparing or stripping text.
 */
export type AgentExperiencePresentation = "primary_card" | "supplementary_note";

export type ScopeDiscoverySensitivity =
  | "standard"
  | "sensitive"
  | "restricted";

export type ScopeDiscoveryItem = {
  scopeRef: string;
  pathSegments?: string[];
  label: string;
  description: string | null;
  domain: string;
  sensitivity: ScopeDiscoverySensitivity;
};

export type ScopeDiscoveryExperience = {
  type: typeof SCOPE_DISCOVERY_EXPERIENCE_TYPE;
  person: {
    /** Public subject reference retained for authority binding; never rendered as an identifier. */
    personRef: string | null;
    displayName: string;
    profilePath: string;
    relationship: string | null;
  };
  domainFilter: string | null;
  scopes: ScopeDiscoveryItem[];
  scopeCatalog?: PersonScopeCatalog;
  catalogIncomplete?: boolean;
  /** One's preselected ask (contract C4); absent means show the catalog. */
  proposal?: ScopeProposal;
};

type ReviewField = {
  label: string;
  domain: string;
  sensitivity: ScopeDiscoverySensitivity;
  /** Safe per-item reference used only to reconcile current status. */
  requestId?: string;
};

export type InformationRequestItemStatus =
  | "pending"
  | "cancelled"
  | "granted"
  | "denied"
  | "expired"
  | "revoked";

export type InformationRequestReviewExperience = {
  type: typeof INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE;
  personName: string;
  purpose: string;
  durationLabel: string;
  direction: "incoming" | "outgoing" | "unknown";
  phase: "draft" | "submitted" | "historical";
  subjectRef: string | null;
  bundleId: string | null;
  requestId: string | null;
  status: "awaiting_review" | "pending" | "mixed" | "cancelled" | "granted" | "denied" | "expired" | "revoked";
  fields: Array<ReviewField & { status?: InformationRequestItemStatus }>;
};

export type DocumentRequestReviewExperience = {
  type: typeof DOCUMENT_REQUEST_REVIEW_EXPERIENCE_TYPE;
  personRef: string;
  personName: string;
  clientRequestId: string;
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
};

/** The owner stages sharing their own Drive files with one connected person. */
export type DriveShareReviewExperience = {
  type: typeof DRIVE_SHARE_REVIEW_EXPERIENCE_TYPE;
  /** One connected person, or the owner's Trusted circle (no person). */
  audience: "person" | "trusted_circle";
  personRef: string | null;
  personName: string | null;
  clientRequestId: string;
  filesRequest: string;
};

/** Explicit user request to review a complete saved-search result set. */
export type DriveBulkShareReviewExperience = {
  type: typeof DRIVE_BULK_SHARE_REVIEW_EXPERIENCE_TYPE;
  audience: "trusted_circle";
  searchJobId: string;
  clientRequestId: string;
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
  presentationIncomplete: boolean;
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

export const SHARED_WITH_ME_CARD_EXPERIENCE_TYPE = "one.shared_with_me_card.v1" as const;

/** One item of the secure "Shared with you" card (CONTRACT-2 C6). It carries no values. */
export type SharedWithMeCardItem = {
  /** Stable within the card: the grant reference, else the item, else its position. */
  key: string;
  grantRef: string | null;
  bundleId: string | null;
  requestId: string | null;
  label: string;
  /** The server's C7 reading, or null when it sent none; the client resolves the rest. */
  sensitivity: "sensitive" | "standard" | null;
  domain: string | null;
  fieldOutline: string[];
  /**
   * Each outlined field's own C7 reading: an identifier field inside a
   * standard item (an EIN under "Legal entity") is sensitive. Names only.
   */
  fields?: SharedFieldSensitivity[];
  sharedAt: string | null;
  accessEndsAt: string | null;
  purpose: string | null;
  /** Present when the server already knows access ended. */
  status: "granted" | "revoked" | "expired" | null;
  /** False when the server knows there is nothing to open (no bundle); rare. */
  decryptable?: boolean;
};

export type SharedWithMeCard = {
  person: { personRef: string; displayName: string; profilePath: string | null; photoUrl: string | null };
  items: SharedWithMeCardItem[];
  /** The server's name for the client open path; informational, never executed. */
  decryptVia: string | null;
};

/** One secure card per person; a result about several people carries several. */
export type SharedWithMeCardExperience = {
  type: typeof SHARED_WITH_ME_CARD_EXPERIENCE_TYPE;
  cards: SharedWithMeCard[];
};

export type AgentStructuredExperience =
  | SharedWithMeCardExperience
  | PersonSelectionExperience
  | ConnectorReadExperience
  | WorkspaceConnectorSetupExperience
  | CustomConnectorProbeExperience
  | ScopeDiscoveryExperience
  | InformationRequestReviewExperience
  | DocumentRequestReviewExperience
  | DriveShareReviewExperience
  | DriveBulkShareReviewExperience
  | KycReadinessExperience
  | MemoryImportReviewExperience
  | EvidenceBriefExperience
  | StyleSettingsOfferExperience;

export type AgentStructuredExperienceWithPresentation = AgentStructuredExperience & {
  presentation?: AgentExperiencePresentation;
};

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

function parsePresentation(value: unknown): AgentExperiencePresentation | null {
  const record = unwrapToolResult(value);
  const presentation = record?.presentation;
  return presentation === "primary_card" || presentation === "supplementary_note"
    ? presentation
    : null;
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
    const requestId = boundedString(field?.requestId, 128);
    return [{
      label,
      domain,
      sensitivity: normalizeSensitivity(field?.sensitivity),
      ...(requestId && /^[A-Za-z0-9_-]{8,128}$/.test(requestId) ? { requestId } : {}),
    }];
  });
}

function parseInformationRequestReview(content: unknown): InformationRequestReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const personName = boundedString(record.personName, 120);
  const purpose = boundedString(record.purpose, 500);
  const durationLabel = boundedString(record.durationLabel, 100);
  const status = boundedString(record.status, 32) as InformationRequestReviewExperience["status"] | null;
  if (!personName || !purpose || !durationLabel || !status || !["awaiting_review", "pending", "mixed", "cancelled", "granted", "denied", "expired", "revoked"].includes(status)) return null;
  const directionValue = boundedString(record.direction, 16);
  const phaseValue = boundedString(record.phase, 16);
  const subjectRef = boundedString(record.subjectRef, 128);
  const safeSubjectRef = subjectRef && /^[A-Za-z0-9_-]{16,128}$/.test(subjectRef) ? subjectRef : null;
  const safeDirection = directionValue === "incoming" || directionValue === "outgoing"
    ? directionValue
    : "unknown";
  const hasReliableBinding = Boolean(safeSubjectRef) && safeDirection !== "unknown";
  const bundleId = boundedString(record.bundleId, 128);
  const requestId = boundedString(record.requestId, 128);
  const fields = parseReviewFields(record.fields).map((field, index) => {
    const raw = Array.isArray(record.fields) ? asRecord(record.fields[index]) : null;
    const fieldStatus = boundedString(raw?.status, 32) as InformationRequestItemStatus | null;
    return fieldStatus && ["pending", "cancelled", "granted", "denied", "expired", "revoked"].includes(fieldStatus)
      ? { ...field, status: fieldStatus }
      : field;
  });
  return {
    type: INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE,
    personName,
    purpose,
    durationLabel,
    // A descriptor without a bound subject is a legacy preview only. It must
    // not imply who is involved or trigger a current authority lookup that
    // could attach another person's status.
    direction: hasReliableBinding ? safeDirection : "unknown",
    phase: hasReliableBinding && (phaseValue === "draft" || phaseValue === "submitted")
      ? phaseValue
      : "historical",
    subjectRef: safeSubjectRef,
    bundleId: bundleId && /^[A-Za-z0-9_-]{8,128}$/.test(bundleId) ? bundleId : null,
    requestId: requestId && /^[A-Za-z0-9_-]{8,128}$/.test(requestId) ? requestId : null,
    status,
    fields,
  };
}

function parseInformationRequestProposal(
  content: unknown,
): InformationRequestReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record || record.status !== "proposal_ready") return null;
  const person = asRecord(record.person);
  const personName = boundedString(person?.displayName, 120);
  const subjectRef = boundedString(person?.personRef, 128);
  const profilePath = boundedString(person?.profilePath, 180);
  const purpose = boundedString(record.purpose, 500);
  const durationHours = boundedInteger(record.durationHours, 720);
  if (
    !personName ||
    !subjectRef ||
    !PUBLIC_PERSON_REF_PATTERN.test(subjectRef) ||
    !profilePath ||
    !PROFILE_PATH_PATTERN.test(profilePath) ||
    profilePath.slice("/people/".length) !== subjectRef ||
    !purpose ||
    durationHours === null ||
    durationHours < 1
  ) {
    return null;
  }

  const fields = (Array.isArray(record.fields) ? record.fields : []).flatMap(
    (field) => {
      if (typeof field === "string") {
        const label = boundedString(field, 120);
        return label
          ? [{ label, domain: "Information", sensitivity: "standard" as const }]
          : [];
      }
      return parseReviewFields([field], 1);
    },
  );
  if (!fields.length) return null;
  const durationLabel =
    durationHours % 24 === 0
      ? `${durationHours / 24} ${durationHours / 24 === 1 ? "day" : "days"}`
      : `${durationHours} ${durationHours === 1 ? "hour" : "hours"}`;
  return {
    type: INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE,
    personName,
    purpose,
    durationLabel,
    direction: "outgoing",
    phase: "draft",
    subjectRef,
    bundleId: null,
    requestId: null,
    status: "awaiting_review",
    fields,
  };
}

function parseDocumentRequestReview(content: unknown): DocumentRequestReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const person = asRecord(record.person);
  const purposeRecord = asRecord(record.purpose);
  const personRef = boundedString(record.personRef ?? person?.personRef, 36);
  const personName = boundedString(record.personName ?? person?.displayName, 120);
  const clientRequestId = boundedString(record.clientRequestId, 36);
  const purpose = boundedString(purposeRecord?.purpose ?? record.purpose, 2000);
  const periodStart = boundedString(record.periodStart ?? purposeRecord?.periodStart, 10);
  const periodEnd = boundedString(record.periodEnd ?? purposeRecord?.periodEnd, 10);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!personRef || !uuid.test(personRef) || !clientRequestId || !uuid.test(clientRequestId) ||
      !personName || !purpose || (periodStart === null) !== (periodEnd === null) ||
      (periodStart !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd ?? "") || periodEnd! < periodStart))) return null;
  return { type: DOCUMENT_REQUEST_REVIEW_EXPERIENCE_TYPE, personRef, personName,
    clientRequestId, purpose, periodStart, periodEnd };
}

function parseDriveShareReview(content: unknown): DriveShareReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record) return null;
  const person = asRecord(record.person);
  const clientRequestId = boundedString(record.clientRequestId, 36);
  const filesRequest = boundedString(record.filesRequest, 2000);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!clientRequestId || !uuid.test(clientRequestId) || !filesRequest?.trim()) return null;
  if (record.audience === "trusted_circle") {
    return { type: DRIVE_SHARE_REVIEW_EXPERIENCE_TYPE, audience: "trusted_circle",
      personRef: null, personName: null, clientRequestId, filesRequest };
  }
  const personRef = boundedString(record.personRef ?? person?.personRef, 36);
  const personName = boundedString(record.personName ?? person?.displayName, 120);
  if (!personRef || !uuid.test(personRef) || !personName) return null;
  return { type: DRIVE_SHARE_REVIEW_EXPERIENCE_TYPE, audience: "person", personRef, personName,
    clientRequestId, filesRequest };
}

function parseDriveBulkShareReview(content: unknown): DriveBulkShareReviewExperience | null {
  const record = unwrapToolResult(content);
  if (!record || record.audience !== "trusted_circle") return null;
  const searchJobId = boundedString(record.searchJobId, 36);
  const clientRequestId = boundedString(record.clientRequestId, 36);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!searchJobId || !uuid.test(searchJobId) || !clientRequestId || !uuid.test(clientRequestId)) return null;
  return { type: DRIVE_BULK_SHARE_REVIEW_EXPERIENCE_TYPE, audience: "trusted_circle", searchJobId, clientRequestId };
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
  const rawGroups = record.groups;
  let presentationIncomplete = sourceBlockCount !== accountedBlockCount || !Array.isArray(rawGroups);
  if (Array.isArray(rawGroups) && rawGroups.length > 50) presentationIncomplete = true;
  const seenCandidateRefs = new Set<string>();
  const groups = (Array.isArray(rawGroups) ? rawGroups.slice(0, 50) : []).flatMap((rawGroup) => {
    const group = asRecord(rawGroup);
    const domain = boundedString(group?.domain, 80);
    if (!domain || !Array.isArray(group?.candidates)) {
      presentationIncomplete = true;
      return [];
    }
    const rawCandidates = group.candidates;
    if (rawCandidates.length > 250) presentationIncomplete = true;
    const candidates = rawCandidates.slice(0, 250).flatMap((rawCandidate) => {
      const candidate = asRecord(rawCandidate);
      const candidateRef = boundedString(candidate?.candidateRef, 180);
      const label = boundedString(candidate?.label, 120);
      const preview = boundedString(candidate?.preview, 280);
      const sharingPosture = boundedString(candidate?.sharingPosture, 32) as MemoryImportReviewExperience["groups"][number]["candidates"][number]["sharingPosture"] | null;
      if (!candidateRef || !label || !preview || !sharingPosture || !["private", "ask_first", "discoverable"].includes(sharingPosture) || seenCandidateRefs.has(candidateRef)) {
        presentationIncomplete = true;
        return [];
      }
      seenCandidateRefs.add(candidateRef);
      return [{ candidateRef, label, preview, sharingPosture, sensitivity: normalizeSensitivity(candidate?.sensitivity) }];
    });
    return [{ domain, candidates }];
  });
  return { type: MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE, sourceBlockCount, accountedBlockCount, presentationIncomplete, groups };
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
  const profilePersonRef = profilePath.slice("/people/".length);
  const rawPersonRef = boundedString(person.personRef, 128);
  const personRef = rawPersonRef && PUBLIC_PERSON_REF_PATTERN.test(rawPersonRef)
    && rawPersonRef === profilePersonRef
    ? rawPersonRef
    : null;
  // A supplied subject reference is security-relevant. A malformed or
  // mismatched reference must invalidate the card instead of falling back to
  // identity reconstructed from a display route.
  if (rawPersonRef && !personRef) return null;

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
        ...(Array.isArray(scope.pathSegments) ? { pathSegments: scope.pathSegments
          .slice(0, 32).flatMap((part) => { const value = boundedString(part, 120); return value ? [value] : []; }) } : {}),
        description: boundedString(scope.description, 280),
        domain,
        sensitivity: normalizeSensitivity(scope.sensitivity),
      },
    ];
  });

  const catalog = asRecord(record.scopeCatalog);
  const page = Number(catalog?.page);
  const nextPage = catalog?.nextPage;
  const totalCount = Number(catalog?.totalCount);
  const revision = boundedString(catalog?.catalogRevision, 64);
  const validCatalog = catalog && Number.isInteger(page) && page > 0
    && Number.isInteger(totalCount) && totalCount >= scopes.length
    && revision && /^[a-f0-9]{64}$/.test(revision)
    && typeof catalog.hasMore === "boolean"
    && (catalog.hasMore ? nextPage === page + 1 : nextPage === null);
  const proposal = parseScopeProposal(record);

  return {
    type: SCOPE_DISCOVERY_EXPERIENCE_TYPE,
    person: {
      personRef,
      displayName,
      profilePath,
      relationship: boundedString(person.relationship, 64),
    },
    domainFilter: boundedString(record.domainFilter, 80),
    scopes,
    ...(validCatalog ? { scopeCatalog: {
      page, nextPage: nextPage as number | null, totalCount,
      limit: Math.max(1, Math.min(Number(catalog.limit) || 100, 100)),
      hasMore: catalog.hasMore as boolean, catalogRevision: revision,
      paginationReset: catalog.paginationReset === true,
      domains: (Array.isArray(catalog.domains) ? catalog.domains : []).flatMap(value => {
        const entry = asRecord(value);
        const domain = boundedString(entry?.domain, 80);
        const count = Number(entry?.count);
        return domain && Number.isInteger(count) && count >= 0 ? [{ domain, count }] : [];
      }),
    } } : {}),
    ...(record.catalogIncomplete === true || (Array.isArray(record.requestableScopes) && record.requestableScopes.length > MAX_SCOPES)
      ? { catalogIncomplete: true } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

const SHARED_REF_PATTERN = /^[A-Za-z0-9_.:-]{6,160}$/;
const SHARED_MAX_ITEMS = 50;

function isoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Milliseconds from the share list ("expiresAt").
    return new Date(value).toISOString();
  }
  const text = boundedString(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

/**
 * A human label even when a machine one slips through: "Tax Record Domain"
 * and "tax_record" both read "Tax record".
 */
export function humanSharedLabel(value: unknown): string | null {
  const raw = boundedString(value, 120);
  if (!raw) return null;
  const spaced = raw.replace(/[_]+/g, " ").replace(/\s+domain$/i, "").trim();
  if (!spaced) return null;
  const machine = spaced === spaced.toLowerCase() || /^([A-Z][a-z]+)(\s[A-Z][a-z]+)+$/.test(spaced);
  const sentence = machine ? spaced.toLowerCase() : spaced;
  return sentence[0]!.toUpperCase() + sentence.slice(1);
}

function sharedRef(value: unknown): string | null {
  const text = boundedString(value, 160);
  return text && SHARED_REF_PATTERN.test(text) ? text : null;
}

function parseSharedWithMeItems(value: unknown, fallbackPurpose: string | null): SharedWithMeCardItem[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value.slice(0, SHARED_MAX_ITEMS) : []).flatMap((raw, index) => {
    const item = asRecord(raw);
    const label = humanSharedLabel(item?.label);
    if (!item || !label) return [];
    const grantRef = sharedRef(item.grantRef ?? item.grant_ref);
    const bundleId = sharedRef(item.bundleId ?? item.bundle_id);
    const requestId = sharedRef(item.requestId ?? item.request_id);
    const key = grantRef ?? requestId ?? `${bundleId ?? "item"}:${index}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const declared = boundedString(item.sensitivity, 32)?.toLowerCase();
    const status = boundedString(item.status, 32)?.toLowerCase();
    const outline = item.fieldOutline ?? item.field_outline;
    const fields = parseSharedFieldSensitivities(item.fields);
    return [{
      key,
      grantRef,
      bundleId,
      requestId,
      label,
      sensitivity: declared === "standard" ? "standard"
        : declared && ["sensitive", "restricted", "high", "medium"].includes(declared) ? "sensitive" : null,
      domain: boundedString(item.domain, 80),
      fieldOutline: (Array.isArray(outline) ? outline.slice(0, 24) : [])
        .flatMap((name) => { const text = boundedString(name, 60); return text ? [text] : []; }),
      sharedAt: isoOrNull(item.sharedAt ?? item.shared_at),
      accessEndsAt: isoOrNull(item.accessEndsAt ?? item.access_ends_at ?? item.expiresAt ?? item.expires_at),
      purpose: boundedString(item.purpose, 500) ?? fallbackPurpose,
      status: status === "granted" || status === "revoked" || status === "expired" ? status : null,
      ...(item.decryptable === false ? { decryptable: false } : {}),
      ...(fields.length ? { fields } : {}),
    }];
  });
}

function parseOneSharedCard(record: Record<string, unknown>): SharedWithMeCard | null {
  const person = asRecord(record.person);
  const personRef = boundedString(person?.personRef ?? person?.person_ref, 128);
  const displayName = boundedString(person?.displayName ?? person?.display_name, 120);
  if (!personRef || !PUBLIC_PERSON_REF_PATTERN.test(personRef) || !displayName) return null;
  const rawPath = boundedString(person?.profilePath ?? person?.profile_path, 240);
  // `/people/{ref}`, optionally with the Shared section's query and anchor.
  const profilePath = rawPath && rawPath.startsWith(`/people/${personRef}`)
    && /^\/people\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&-]*)?(?:#[A-Za-z0-9_-]*)?$/.test(rawPath) ? rawPath : null;
  const rawPhoto = boundedString(person?.photoUrl ?? person?.photo_url, 500);
  const photoUrl = rawPhoto && /^https:\/\//.test(rawPhoto) ? rawPhoto : null;
  const items = parseSharedWithMeItems(record.items ?? record.shares, boundedString(record.purpose, 500));
  if (!items.length) return null;
  const decryptVia = record.decryptVia ?? record.decrypt_via;
  return {
    person: { personRef, displayName, profilePath, photoUrl },
    items,
    decryptVia: typeof decryptVia === "string" ? boundedString(decryptVia, 120)
      : boundedString(asRecord(decryptVia)?.kind, 120),
  };
}

/**
 * CONTRACT-2 C6, read tolerantly: `kind` or `type`, camelCase or snake_case;
 * the card under `card`, a list under `cards`, or the card at the result's
 * root (also under `structured` or `result`); items under `items` or the
 * share list's `shares`. Each card needs one verified person and at least
 * one item; a person appears once.
 */
export function parseSharedWithMeCard(content: unknown): SharedWithMeCardExperience | null {
  const root = unwrapToolResult(content);
  if (!root) return null;
  const isCard = (value: Record<string, unknown> | null): value is Record<string, unknown> =>
    Boolean(value) && (value!.kind ?? value!.type) === SHARED_WITH_ME_CARD_EXPERIENCE_TYPE;
  const listed = Array.isArray(root.cards) ? root.cards.slice(0, 20).map(asRecord) : [];
  const candidates = [asRecord(root.card), ...listed, root, asRecord(root.structured), parseRecord(root.result)];
  const cards: SharedWithMeCard[] = [];
  for (const candidate of candidates) {
    if (!isCard(candidate)) continue;
    const card = parseOneSharedCard(candidate);
    if (card && !cards.some((entry) => entry.person.personRef === card.person.personRef)) cards.push(card);
  }
  return cards.length ? { type: SHARED_WITH_ME_CARD_EXPERIENCE_TYPE, cards } : null;
}

const EXPERIENCE_REGISTRY: Record<string, ExperienceParser> = {
  [SHARED_WITH_ME_CARD_EXPERIENCE_TYPE]: parseSharedWithMeCard,
  [SCOPE_DISCOVERY_EXPERIENCE_TYPE]: parseScopeDiscovery,
  [INFORMATION_REQUEST_REVIEW_EXPERIENCE_TYPE]: parseInformationRequestReview,
  [DOCUMENT_REQUEST_REVIEW_EXPERIENCE_TYPE]: parseDocumentRequestReview,
  [DRIVE_SHARE_REVIEW_EXPERIENCE_TYPE]: parseDriveShareReview,
  [DRIVE_BULK_SHARE_REVIEW_EXPERIENCE_TYPE]: parseDriveBulkShareReview,
  [KYC_READINESS_EXPERIENCE_TYPE]: parseKycReadiness,
  [MEMORY_IMPORT_REVIEW_EXPERIENCE_TYPE]: parseMemoryImportReview,
  [EVIDENCE_BRIEF_EXPERIENCE_TYPE]: parseEvidenceBrief,
  [WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE]: parseWorkspaceConnectorSetupDescriptor,
};

export function parseAgentActivityExperience(
  activityType: string,
  content: unknown,
): AgentStructuredExperienceWithPresentation | null {
  const parser = EXPERIENCE_REGISTRY[activityType];
  const experience = parser ? parser(content) : null;
  const presentation = experience ? parsePresentation(content) : null;
  return experience && presentation ? { ...experience, presentation } : experience;
}

export function parseAgentToolResultExperience(
  toolName: string,
  content: unknown,
  toolArguments?: unknown,
): AgentStructuredExperienceWithPresentation | null {
  const connectorSetup = parseWorkspaceConnectorSetup(
    toolName,
    content,
    toolArguments,
  );
  if (connectorSetup) return connectorSetup;
  const probe = parseCustomConnectorProbe(toolName, content);
  if (probe) return probe;
  // C6: whichever tool the backend names for it, a result that carries the
  // shared-with-me card renders it.
  const sharedCard = parseSharedWithMeCard(content);
  if (sharedCard) return sharedCard;
  if (toolName === "ask_email_agent" || toolName === "ask_documents_agent") {
    const receipt = parseConnectorReadReceipt(unwrapToolResult(content)?.structured);
    return receipt?.connector === (toolName === "ask_email_agent" ? "mail" : "drive")
      ? receipt : null;
  }
  if (toolName === "read_workspace_tool") {
    const result = unwrapToolResult(content);
    const argumentProvider = parseRecord(toolArguments)?.provider;
    const resultProvider = result?.provider;
    if ((resultProvider ?? argumentProvider) !== "drive" ||
      (resultProvider !== undefined && argumentProvider !== undefined && resultProvider !== argumentProvider)) return null;
    const receipt = parseConnectorReadReceipt(result?.structured);
    return receipt?.connector === "drive" && result?.status === receipt.status ? receipt : null;
  }
  if (toolName === "propose_drive_bulk_share") {
    const result = unwrapToolResult(content);
    return result?.status === "proposal_ready" ? parseDriveBulkShareReview(content) : null;
  }
  if (toolName === "propose_style_settings") {
    const result = unwrapToolResult(content);
    const proposed = result?.status === "offer_ready" ? parseOwnerStyleProposal(result.proposed) : null;
    return proposed ? { type: STYLE_SETTINGS_OFFER_EXPERIENCE_TYPE, proposed } : null;
  }
  const supportsPersonSelection =
    toolName === "discover_person_information" ||
    toolName === "propose_information_request" ||
    toolName === "propose_document_request" ||
    toolName === "propose_drive_share" ||
    toolName === "list_information_shared_with_me";
  if (!supportsPersonSelection) return null;
  const sourceTool: PersonSelectionSourceTool = toolName;
  const result = unwrapToolResult(content);
  if (result?.status === "needs_clarification" && Array.isArray(result.candidates)) {
    const candidates = result.candidates.slice(0, 20).flatMap((value) => {
      const candidate = asRecord(value);
      const selectionHandle = boundedString(candidate?.selectionHandle, 64);
      const personRef = boundedString(candidate?.personRef, 128);
      const displayName = boundedString(candidate?.displayName, 120);
      const profilePath = boundedString(candidate?.profilePath, 180);
      const profilePersonRef = profilePath?.slice("/people/".length);
      if (!selectionHandle || !/^[a-f0-9]{32}$/.test(selectionHandle) || !displayName ||
          !personRef || !PUBLIC_PERSON_REF_PATTERN.test(personRef) || !profilePath ||
          !PROFILE_PATH_PATTERN.test(profilePath) || personRef !== profilePersonRef) return [];
      return [{ personRef, selectionHandle, displayName, profilePath, detail: boundedString(candidate?.detail, 120) }];
    });
    return candidates.length
      ? {
          type: PERSON_SELECTION_EXPERIENCE_TYPE,
          sourceTool,
          candidates,
          ...(result.candidatesIncomplete === true ? { candidatesIncomplete: true } : {}),
        }
      : null;
  }
  if (toolName === "propose_information_request") {
    // A5 (localhost run 4): asked again while the same request waits, the
    // server reports it as waiting with the living card's descriptor. It
    // renders that request's card, never an ask card with Send.
    if (result?.status === "already_pending") {
      const living = parseInformationRequestReview(result.livingCard);
      return living && living.direction === "outgoing" && living.phase === "submitted" && living.bundleId
        ? living : null;
    }
    // C4: a proposal names the person and One's pick; it renders as the ask
    // card over the catalog. Older servers still return a draft review.
    if (Array.isArray(result?.proposed) || Array.isArray(asRecord(result?.proposal)?.proposed)) {
      const discovery = parseScopeDiscovery({ ...result, status: "ok" });
      if (discovery?.proposal) return discovery;
    }
    return parseInformationRequestProposal(content);
  }
  if (toolName === "propose_document_request") {
    const result = unwrapToolResult(content);
    return result?.status === "proposal_ready" ? parseDocumentRequestReview(content) : null;
  }
  if (toolName === "propose_drive_share") {
    const result = unwrapToolResult(content);
    return result?.status === "proposal_ready" ? parseDriveShareReview(content) : null;
  }
  const experience = parseScopeDiscovery(content);
  const presentation = experience ? parsePresentation(content) : null;
  return experience && presentation ? { ...experience, presentation } : experience;
}
