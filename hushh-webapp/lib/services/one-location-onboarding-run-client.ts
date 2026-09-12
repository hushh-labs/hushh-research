"use client";

import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { ONE_LOCATION_WORKFLOW_CARD_CATALOG } from "@/lib/generated/one-location-workflow-card-catalog.v1";
import {
  markLocationDirectiveResponse,
  recordLocationInteractionSettled,
  recordLocationRunStarted,
} from "@/lib/one-location/one-location-runtime-telemetry";

export const ONE_LOCATION_ONBOARDING_WORKFLOW_ID =
  "workflow.setup.location" as const;
export const ONE_LOCATION_WORKFLOW_SURFACE_ID =
  "render.one_location_workflow_card" as const;
export const ONE_LOCATION_INTERACTION_DEADLINE_MS = 30_000;

const RESULT_SCHEMA_VERSION = "one.location_onboarding_run_result.v1";
const PROJECTION_SCHEMA_VERSION = "one.location_run_projection.v1";
const DIRECTIVE_SCHEMA_VERSION = "one.location_interaction_directive.v1";
const API_ROOT = "/api/one/workflows/location/onboarding/runs";
const CACHE_VERSION = 2;
const CACHE_PREFIX = "one_location_run_projection_v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const SAFE_TOKEN_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/u;
const RUN_ID_PATTERN = /^run_[a-z0-9]{16,96}$/u;
const DIRECTIVE_ID_PATTERN = /^locdirective_[a-z0-9]{16,96}$/u;
const LEASE_ID_PATTERN = /^loclease_[a-z0-9]{16,96}$/u;
const DRAFT_REF_PATTERN = /^locdraft_[a-z0-9]{16,96}$/u;
const PKM_FINALIZE_AUTHORIZATION_ID_PATTERN = /^locpkmauth_[a-z0-9]{16,96}$/u;
const PKM_FINALIZE_TOKEN_PATTERN =
  /^locpkmtoken_[a-z0-9]{16,96}_[0-9a-f]{64}$/u;
const GRAPH_REVISION_PATTERN = /^[a-f0-9]{16,128}$/u;
const DRAFT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITION_OBSERVATION_SCHEMA_VERSION =
  "one.location_position_observation.v1" as const;
const POSITION_OBSERVATION_MAX_AGE_MS = 30_000;
const POSITION_OBSERVATION_MAX_FUTURE_SKEW_MS = 5_000;

export type LocationCapabilityRunStatus =
  | "proposed"
  | "needs_input"
  | "entity_choice"
  | "interaction_required"
  | "confirmation_required"
  | "authorized"
  | "executing"
  | "settlement_received"
  | "verified_succeeded"
  | "verified_failed"
  | "paused"
  | "cancelled"
  | "expired";

export type LocationInteractionState =
  | "permission_required"
  | "permission_waiting"
  | "permission_settings_required"
  | "location_services_required"
  | "capturing"
  | "capture_retry"
  | "place_required"
  | "resume_required"
  | "verified_complete"
  | "secure_task_unavailable";

export type LocationServerDirectiveContract =
  (typeof ONE_LOCATION_WORKFLOW_CARD_CATALOG.variants)[number];
export type LocationServerDirectiveContractId =
  LocationServerDirectiveContract["contractId"];
export type LocationServerDirectiveKind =
  LocationServerDirectiveContract["kind"];

type RuntimeDirectiveContract = LocationServerDirectiveContract & {
  allowedResults: readonly string[];
};

/** Build-generated bounded projection; CapabilityGraphV1 is its only source. */
export const ONE_LOCATION_SERVER_DIRECTIVE_CATALOG = Object.freeze(
  Object.fromEntries(
    ONE_LOCATION_WORKFLOW_CARD_CATALOG.variants.map((variant) => [
      variant.contractId,
      Object.freeze({
        ...variant,
        allowedResults: Object.freeze(
          variant.results.map((result) => result.result),
        ),
      }),
    ]),
  ),
) as Readonly<
  Record<LocationServerDirectiveContractId, RuntimeDirectiveContract>
>;

export type LocationTechnicalInteractionDirectiveV1 = {
  schemaVersion: typeof DIRECTIVE_SCHEMA_VERSION;
  directiveId: string;
  contractId: LocationServerDirectiveContractId;
  kind: LocationServerDirectiveKind;
  surfaceId: typeof ONE_LOCATION_WORKFLOW_SURFACE_ID;
  titleKey: string;
  bodyKey: string;
  allowedResults: readonly string[];
  expiresAt: string;
  lease: {
    leaseId: string;
    runRevision: number;
  };
};

export type LocationRunProjectionV1 = {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  workflowId: typeof ONE_LOCATION_ONBOARDING_WORKFLOW_ID;
  workflowVersion: number;
  graphRevision: string;
  runId: string;
  revision: number;
  status: LocationCapabilityRunStatus;
  cursor: string;
  completionClaimAllowed: boolean;
  pendingDirective: LocationTechnicalInteractionDirectiveV1 | null;
  evidence: {
    permission: boolean;
    place: boolean;
    circle: boolean;
    completion: boolean;
  };
  draft: {
    draftRef: string;
    status: "staged";
    expiresAt: string;
  } | null;
  /** Ephemeral server capability. Never write this member to browser storage. */
  pkmFinalizeAuthorization: LocationPkmFinalizeAuthorizationV1 | null;
};

export type LocationPkmFinalizeAuthorizationV1 = {
  schemaVersion: "one.location_pkm_finalize_authorization.v1";
  authorizationId: string;
  token: string;
  runId: string;
  runRevision: number;
  leaseId: string;
  directiveId: string;
  draftRef: string;
  draftDigest: string;
  expectedCommitId: string;
  expiresAt: string;
};

export type LocationOnboardingRunResultV1 = {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  run: LocationRunProjectionV1;
  directive: LocationTechnicalInteractionDirectiveV1 | null;
  waitingReason: string | null;
};

export type LocationPreVaultDraftMetadataV1 = {
  schemaVersion: "one.location.pre_vault.draft_metadata.v1";
  digest: string;
  status: "staged";
  expiresAt: string;
  runId: string;
  revision: number;
};

export type LocationPositionObservationV1 = {
  schemaVersion: typeof POSITION_OBSERVATION_SCHEMA_VERSION;
  permissionStatus: "granted";
  capturedAt: string;
  sourcePlatform: "web" | "ios" | "android" | "native";
};

/** Optional owner-bound credential captured before an auth identity changes. */
export type OneLocationRunAuthOptions = {
  bearerToken?: string | null;
  expectedUserId?: string;
};

/** Client-owned display state. It never grants action authority. */
export type LocationInteractionDirectiveV1 =
  | {
      schemaVersion: typeof DIRECTIVE_SCHEMA_VERSION;
      authority: "server";
      surface: typeof ONE_LOCATION_WORKFLOW_SURFACE_ID;
      run: LocationRunProjectionV1;
      serverDirective: LocationTechnicalInteractionDirectiveV1;
      dismissible: false;
    }
  | {
      schemaVersion: typeof DIRECTIVE_SCHEMA_VERSION;
      authority: "local";
      surface: typeof ONE_LOCATION_WORKFLOW_SURFACE_ID;
      state: LocationInteractionState;
      run: LocationRunProjectionV1 | null;
      dismissible: boolean;
    };

type StoredProjectionV2 = Omit<
  LocationRunProjectionV1,
  "pkmFinalizeAuthorization"
> & {
  pkmFinalizeAuthorization: null;
  cacheVersion: typeof CACHE_VERSION;
  cachedAtMs: number;
  expiresAtMs: number;
};

const RUN_STATUSES = new Set<LocationCapabilityRunStatus>([
  "proposed",
  "needs_input",
  "entity_choice",
  "interaction_required",
  "confirmation_required",
  "authorized",
  "executing",
  "settlement_received",
  "verified_succeeded",
  "verified_failed",
  "paused",
  "cancelled",
  "expired",
]);

const TERMINAL_STATUSES = new Set<LocationCapabilityRunStatus>([
  "verified_succeeded",
  "verified_failed",
  "cancelled",
  "expired",
]);

const LOCATION_CURSORS = new Set([
  "location.onboarding.preflight",
  "location.onboarding.introduction",
  "location.onboarding.permission",
  "location.onboarding.position",
  "location.onboarding.place",
  "location.onboarding.circle",
  "location.onboarding.complete",
]);

const DIRECTIVE_KINDS = new Set<
  LocationTechnicalInteractionDirectiveV1["kind"]
>([
  "information",
  "technical_interaction",
  "progress",
  "form",
  "recovery",
  "status",
]);

function nonEmptyString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maximum ? clean : null;
}

function optionalString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return nonEmptyString(value, maximum);
}

function integer(value: unknown, minimum: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function field(
  source: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): unknown {
  return source[camelCase] ?? source[snakeCase];
}

function safeToken(value: unknown, maximum: number): string | null {
  const clean = nonEmptyString(value, maximum);
  return clean && SAFE_TOKEN_PATTERN.test(clean) ? clean : null;
}

function exactToken(
  value: unknown,
  maximum: number,
  pattern: RegExp,
): string | null {
  const clean = nonEmptyString(value, maximum);
  return clean && pattern.test(clean) ? clean : null;
}

type LocationGraphRevisionPolicy = {
  graphRevision: string;
  compatibleGraphRevisions: readonly string[];
};

/** Admit only the compiler's current revision or its bounded compatibility chain. */
export function isSupportedLocationGraphRevision(
  value: string,
  policy: LocationGraphRevisionPolicy = ONE_LOCATION_WORKFLOW_CARD_CATALOG,
): boolean {
  return (
    GRAPH_REVISION_PATTERN.test(value) &&
    value.length <= 128 &&
    (value === policy.graphRevision ||
      policy.compatibleGraphRevisions.includes(value))
  );
}

/**
 * Accept only the non-sensitive proof that a fresh OS fix was observed.
 * Coordinates, accuracy, labels, and provider payloads are deliberately not
 * representable in this settlement contract.
 */
export function parseLocationPositionObservation(
  value: unknown,
  nowMs = Date.now(),
): LocationPositionObservationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const expectedKeys = [
    "capturedAt",
    "permissionStatus",
    "schemaVersion",
    "sourcePlatform",
  ];
  if (
    Object.keys(source).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
    source.schemaVersion !== POSITION_OBSERVATION_SCHEMA_VERSION ||
    source.permissionStatus !== "granted" ||
    (source.sourcePlatform !== "web" &&
      source.sourcePlatform !== "ios" &&
      source.sourcePlatform !== "android" &&
      source.sourcePlatform !== "native")
  ) {
    return null;
  }
  const capturedAt = nonEmptyString(source.capturedAt, 64);
  const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  const ageMs = nowMs - capturedAtMs;
  if (
    !capturedAt ||
    !Number.isFinite(capturedAtMs) ||
    ageMs > POSITION_OBSERVATION_MAX_AGE_MS ||
    ageMs < -POSITION_OBSERVATION_MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return {
    schemaVersion: POSITION_OBSERVATION_SCHEMA_VERSION,
    permissionStatus: "granted",
    capturedAt: new Date(capturedAtMs).toISOString(),
    sourcePlatform: source.sourcePlatform,
  };
}

function parseDirective(
  value: unknown,
): LocationTechnicalInteractionDirectiveV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const schemaVersion = field(source, "schemaVersion", "schema_version");
  const directiveId = exactToken(
    field(source, "directiveId", "directive_id"),
    109,
    DIRECTIVE_ID_PATTERN,
  );
  const contractId = safeToken(field(source, "contractId", "contract_id"), 128);
  const kind = field(source, "kind", "kind");
  const surfaceId = field(source, "surfaceId", "surface_id");
  const titleKey = safeToken(field(source, "titleKey", "title_key"), 128);
  const bodyKey = safeToken(field(source, "bodyKey", "body_key"), 128);
  const expiresAt = nonEmptyString(
    field(source, "expiresAt", "expires_at"),
    64,
  );
  const allowedSource = field(source, "allowedResults", "allowed_results");
  const leaseSource = field(source, "lease", "lease");
  const catalogEntry = contractId
    ? ONE_LOCATION_SERVER_DIRECTIVE_CATALOG[
        contractId as LocationServerDirectiveContractId
      ]
    : undefined;
  if (
    schemaVersion !== DIRECTIVE_SCHEMA_VERSION ||
    !directiveId ||
    !contractId ||
    !catalogEntry ||
    kind !== catalogEntry.kind ||
    typeof kind !== "string" ||
    !DIRECTIVE_KINDS.has(
      kind as LocationTechnicalInteractionDirectiveV1["kind"],
    ) ||
    surfaceId !== ONE_LOCATION_WORKFLOW_SURFACE_ID ||
    titleKey !== catalogEntry.titleKey ||
    bodyKey !== catalogEntry.bodyKey ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !Array.isArray(allowedSource) ||
    allowedSource.length === 0 ||
    allowedSource.length > 12 ||
    !leaseSource ||
    typeof leaseSource !== "object" ||
    Array.isArray(leaseSource)
  ) {
    return null;
  }
  const allowedResults = Array.from(
    new Set(
      allowedSource.map((result) => safeToken(result, 64)).filter(Boolean),
    ),
  ) as string[];
  if (
    allowedResults.length !== allowedSource.length ||
    allowedResults.length !== catalogEntry.allowedResults.length ||
    catalogEntry.allowedResults.some(
      (result) => !allowedResults.includes(result),
    )
  ) {
    return null;
  }
  const lease = leaseSource as Record<string, unknown>;
  const leaseId = exactToken(
    field(lease, "leaseId", "lease_id"),
    105,
    LEASE_ID_PATTERN,
  );
  const runRevision = integer(field(lease, "runRevision", "run_revision"), 1);
  if (!leaseId || runRevision === null) return null;
  return {
    schemaVersion: DIRECTIVE_SCHEMA_VERSION,
    directiveId,
    contractId: contractId as LocationServerDirectiveContractId,
    kind: kind as LocationTechnicalInteractionDirectiveV1["kind"],
    surfaceId: ONE_LOCATION_WORKFLOW_SURFACE_ID,
    titleKey,
    bodyKey,
    allowedResults: [...catalogEntry.allowedResults],
    expiresAt: new Date(expiresAt).toISOString(),
    lease: { leaseId, runRevision },
  };
}

function parsePkmFinalizeAuthorization(
  value: unknown,
): LocationPkmFinalizeAuthorizationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const camelKeys = [
    "authorizationId",
    "directiveId",
    "draftDigest",
    "draftRef",
    "expectedCommitId",
    "expiresAt",
    "leaseId",
    "runId",
    "runRevision",
    "schemaVersion",
    "token",
  ];
  const snakeKeys = [
    "authorization_id",
    "directive_id",
    "draft_digest",
    "draft_ref",
    "expected_commit_id",
    "expires_at",
    "lease_id",
    "run_id",
    "run_revision",
    "schema_version",
    "token",
  ];
  const actualKeys = Object.keys(source).sort().join("\u0000");
  if (
    actualKeys !== camelKeys.sort().join("\u0000") &&
    actualKeys !== snakeKeys.sort().join("\u0000")
  ) {
    return null;
  }
  const schemaVersion = field(source, "schemaVersion", "schema_version");
  const authorizationId = exactToken(
    field(source, "authorizationId", "authorization_id"),
    107,
    PKM_FINALIZE_AUTHORIZATION_ID_PATTERN,
  );
  const token = exactToken(
    field(source, "token", "token"),
    210,
    PKM_FINALIZE_TOKEN_PATTERN,
  );
  const runId = exactToken(
    field(source, "runId", "run_id"),
    100,
    RUN_ID_PATTERN,
  );
  const runRevision = integer(field(source, "runRevision", "run_revision"), 1);
  const leaseId = exactToken(
    field(source, "leaseId", "lease_id"),
    105,
    LEASE_ID_PATTERN,
  );
  const directiveId = exactToken(
    field(source, "directiveId", "directive_id"),
    109,
    DIRECTIVE_ID_PATTERN,
  );
  const draftRef = exactToken(
    field(source, "draftRef", "draft_ref"),
    105,
    DRAFT_REF_PATTERN,
  );
  const draftDigest = exactToken(
    field(source, "draftDigest", "draft_digest"),
    64,
    DRAFT_DIGEST_PATTERN,
  );
  const expectedCommitId = exactToken(
    field(source, "expectedCommitId", "expected_commit_id"),
    36,
    UUID_PATTERN,
  );
  const expiresAt = nonEmptyString(
    field(source, "expiresAt", "expires_at"),
    64,
  );
  if (
    schemaVersion !== "one.location_pkm_finalize_authorization.v1" ||
    !authorizationId ||
    !token ||
    !runId ||
    runRevision === null ||
    !leaseId ||
    !directiveId ||
    !draftRef ||
    !draftDigest ||
    !expectedCommitId ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    schemaVersion: "one.location_pkm_finalize_authorization.v1",
    authorizationId,
    token,
    runId,
    runRevision,
    leaseId,
    directiveId,
    draftRef,
    draftDigest,
    expectedCommitId: expectedCommitId.toLowerCase(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Validate a bounded server projection. Client hints, routes, and locally
 * generated identifiers can never be upgraded into a durable capability run.
 */
export function parseLocationRunProjection(
  value: unknown,
): LocationRunProjectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const schemaVersion = field(source, "schemaVersion", "schema_version");
  const workflowId = field(source, "workflowId", "workflow_id");
  const workflowVersion = integer(
    field(source, "workflowVersion", "workflow_version"),
    1,
  );
  const graphRevision = exactToken(
    field(source, "graphRevision", "graph_revision"),
    128,
    GRAPH_REVISION_PATTERN,
  );
  const runId = exactToken(
    field(source, "runId", "run_id"),
    100,
    RUN_ID_PATTERN,
  );
  const revision = integer(source.revision, 1);
  const status = field(source, "status", "status");
  const cursor = nonEmptyString(field(source, "cursor", "step_cursor"), 64);
  const completionClaimAllowed = field(
    source,
    "completionClaimAllowed",
    "completion_claim_allowed",
  );
  const rawDirective = field(source, "pendingDirective", "pending_directive");
  const pendingDirective = rawDirective ? parseDirective(rawDirective) : null;
  const evidenceSource = field(source, "evidence", "evidence");
  const draftSource = field(source, "draft", "draft");
  const rawPkmFinalizeAuthorization = field(
    source,
    "pkmFinalizeAuthorization",
    "pkm_finalize_authorization",
  );
  const pkmFinalizeAuthorization = rawPkmFinalizeAuthorization
    ? parsePkmFinalizeAuthorization(rawPkmFinalizeAuthorization)
    : null;
  const evidence =
    evidenceSource &&
    typeof evidenceSource === "object" &&
    !Array.isArray(evidenceSource)
      ? (evidenceSource as Record<string, unknown>)
      : null;
  let draft: LocationRunProjectionV1["draft"] = null;
  if (draftSource !== null && draftSource !== undefined) {
    if (typeof draftSource !== "object" || Array.isArray(draftSource))
      return null;
    const sourceDraft = draftSource as Record<string, unknown>;
    const draftRef = exactToken(
      field(sourceDraft, "draftRef", "draft_ref"),
      105,
      DRAFT_REF_PATTERN,
    );
    const draftStatus = field(sourceDraft, "status", "status");
    const draftExpiresAt = nonEmptyString(
      field(sourceDraft, "expiresAt", "expires_at"),
      64,
    );
    if (
      !draftRef ||
      draftStatus !== "staged" ||
      !draftExpiresAt ||
      !Number.isFinite(Date.parse(draftExpiresAt))
    ) {
      return null;
    }
    draft = {
      draftRef,
      status: "staged",
      expiresAt: new Date(draftExpiresAt).toISOString(),
    };
  }
  if (
    schemaVersion !== PROJECTION_SCHEMA_VERSION ||
    workflowId !== ONE_LOCATION_ONBOARDING_WORKFLOW_ID ||
    workflowVersion !== ONE_LOCATION_WORKFLOW_CARD_CATALOG.workflowVersion ||
    !graphRevision ||
    !runId ||
    revision === null ||
    typeof status !== "string" ||
    !RUN_STATUSES.has(status as LocationCapabilityRunStatus) ||
    !cursor ||
    !LOCATION_CURSORS.has(cursor) ||
    typeof completionClaimAllowed !== "boolean" ||
    !evidence ||
    typeof evidence.permission !== "boolean" ||
    typeof evidence.place !== "boolean" ||
    typeof evidence.circle !== "boolean" ||
    typeof evidence.completion !== "boolean" ||
    (rawDirective !== null &&
      rawDirective !== undefined &&
      !pendingDirective) ||
    (rawPkmFinalizeAuthorization !== null &&
      rawPkmFinalizeAuthorization !== undefined &&
      !pkmFinalizeAuthorization)
  ) {
    return null;
  }
  const normalizedStatus = status as LocationCapabilityRunStatus;
  const isHistoricalTerminalProjection =
    TERMINAL_STATUSES.has(normalizedStatus) &&
    pendingDirective === null &&
    draft === null;
  // The backend deliberately permits an explicit read of an immutable,
  // terminal historical run. It carries no lease and cannot execute. Active
  // runs must remain pinned to the compiler's current compatibility policy.
  if (
    !isSupportedLocationGraphRevision(graphRevision) &&
    !isHistoricalTerminalProjection
  ) {
    return null;
  }
  if (pendingDirective && pendingDirective.lease.runRevision !== revision) {
    return null;
  }
  if (
    pkmFinalizeAuthorization &&
    (!pendingDirective ||
      pendingDirective.contractId !==
        "one.location.awaiting_vault_finalize.v2" ||
      !draft ||
      pkmFinalizeAuthorization.runId !== runId ||
      pkmFinalizeAuthorization.runRevision !== revision ||
      pkmFinalizeAuthorization.leaseId !== pendingDirective.lease.leaseId ||
      pkmFinalizeAuthorization.directiveId !== pendingDirective.directiveId ||
      pkmFinalizeAuthorization.draftRef !== draft.draftRef ||
      Date.parse(pkmFinalizeAuthorization.expiresAt) >
        Date.parse(pendingDirective.expiresAt) ||
      Date.parse(pkmFinalizeAuthorization.expiresAt) >
        Date.parse(draft.expiresAt))
  ) {
    return null;
  }
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    workflowId: ONE_LOCATION_ONBOARDING_WORKFLOW_ID,
    workflowVersion,
    graphRevision,
    runId,
    revision,
    status: normalizedStatus,
    cursor,
    completionClaimAllowed,
    pendingDirective,
    evidence: {
      permission: evidence.permission,
      place: evidence.place,
      circle: evidence.circle,
      completion: evidence.completion,
    },
    draft,
    pkmFinalizeAuthorization,
  };
}

export function parseLocationOnboardingRunResult(
  value: unknown,
): LocationOnboardingRunResultV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const schemaVersion = field(source, "schemaVersion", "schema_version");
  if (schemaVersion !== RESULT_SCHEMA_VERSION) return null;
  const directiveSource = field(source, "directive", "directive");
  const directive = directiveSource ? parseDirective(directiveSource) : null;
  if (directiveSource !== null && directiveSource !== undefined && !directive) {
    return null;
  }
  const run = parseLocationRunProjection(field(source, "run", "run"));
  if (!run) return null;
  if (JSON.stringify(directive) !== JSON.stringify(run.pendingDirective)) {
    return null;
  }
  const waitingReason = optionalString(
    field(source, "waitingReason", "waiting_reason"),
    96,
  );
  if (
    field(source, "waitingReason", "waiting_reason") !== null &&
    field(source, "waitingReason", "waiting_reason") !== undefined &&
    !waitingReason
  ) {
    return null;
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    run,
    directive,
    waitingReason,
  };
}

export function createLocalLocationInteractionDirective(
  state: LocationInteractionState,
  options: {
    run?: LocationRunProjectionV1 | null;
    dismissible?: boolean;
  } = {},
): LocationInteractionDirectiveV1 {
  return {
    schemaVersion: DIRECTIVE_SCHEMA_VERSION,
    authority: "local",
    surface: ONE_LOCATION_WORKFLOW_SURFACE_ID,
    state,
    run: options.run ?? null,
    dismissible: options.dismissible ?? state !== "capturing",
  };
}

export function createServerLocationInteractionDirective(
  result: LocationOnboardingRunResultV1,
): LocationInteractionDirectiveV1 | null {
  if (!result.directive) return null;
  return {
    schemaVersion: DIRECTIVE_SCHEMA_VERSION,
    authority: "server",
    surface: ONE_LOCATION_WORKFLOW_SURFACE_ID,
    run: result.run,
    serverDirective: result.directive,
    dismissible: false,
  };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function cacheKey(userId: string): Promise<string> {
  const clean = String(userId || "").trim();
  if (!clean) throw new Error("A signed-in user is required.");
  if (!globalThis.crypto?.subtle)
    throw new Error("Secure storage unavailable.");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clean),
  );
  return `${CACHE_PREFIX}:${bytesToBase64Url(new Uint8Array(digest))}`;
}

function storedProjection(
  value: unknown,
  nowMs: number,
): LocationRunProjectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    source.cacheVersion !== CACHE_VERSION ||
    integer(source.expiresAtMs, 0) === null ||
    Number(source.expiresAtMs) <= nowMs
  ) {
    return null;
  }
  return parseLocationRunProjection(source);
}

function boundedExplicitBearer(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const token = value.trim();
  if (!token || token.length > 16_384 || /[\r\n]/u.test(token)) {
    throw new Error("Location task authorization is invalid.");
  }
  return token;
}

async function firebaseBearer(
  explicitBearer?: string | null,
  expectedUserId?: string,
): Promise<string> {
  if (explicitBearer !== null && explicitBearer !== undefined) {
    return boundedExplicitBearer(explicitBearer)!;
  }
  const token = await AuthService.getIdTokenWithRetry({
    retries: 1,
    delayMs: 250,
    ...(expectedUserId ? { expectedUserId } : {}),
  });
  if (!token) throw new Error("Sign in again to continue Location setup.");
  return token;
}

async function fetchRunResult(
  path: string,
  options: RequestInit,
  auth: OneLocationRunAuthOptions = {},
): Promise<LocationOnboardingRunResultV1> {
  const result = await fetchOptionalRunResult(path, options, auth, false);
  if (!result) {
    throw new Error("Agent One returned an invalid Location task.");
  }
  return result;
}

async function fetchOptionalRunResult(
  path: string,
  options: RequestInit,
  auth: OneLocationRunAuthOptions = {},
  allowNoContent = true,
): Promise<LocationOnboardingRunResultV1 | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () =>
      controller.abort(
        new DOMException("Location task timed out.", "TimeoutError"),
      ),
    ONE_LOCATION_INTERACTION_DEADLINE_MS,
  );
  try {
    const token = await firebaseBearer(auth.bearerToken, auth.expectedUserId);
    const response = await ApiService.apiFetch(path, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-store",
      },
    });
    if (allowNoContent && response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Sign in again to continue Location setup."
          : "Agent One could not resume Location setup. Try again.",
      );
    }
    const parsed = parseLocationOnboardingRunResult(await response.json());
    if (!parsed) {
      throw new Error("Agent One returned an invalid Location task.");
    }
    // Keep only the monotonic receipt time and validated opaque identifiers;
    // the response body itself never enters the telemetry buffer.
    markLocationDirectiveResponse(parsed);
    return parsed;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export type BoundedLocationInteractionResult<T> =
  { status: "settled"; value: T } | { status: "timed_out" };

export class OneLocationOnboardingRunClient {
  static async startOrResume(
    input: {
      runId?: string | null;
      contextRevision?: string | null;
      guideMode?: "fast" | "full_guide";
      bearerToken?: string | null;
      expectedUserId?: string;
    } = {},
  ): Promise<LocationOnboardingRunResultV1> {
    const runId = input.runId
      ? exactToken(input.runId, 100, RUN_ID_PATTERN)
      : null;
    if (input.runId && !runId) {
      throw new Error("Location task is invalid.");
    }
    const contextRevision = optionalString(input.contextRevision, 192);
    const result = await fetchRunResult(
      API_ROOT,
      {
        method: "POST",
        body: JSON.stringify({
          ...(runId ? { runId } : {}),
          ...(contextRevision ? { contextRevision } : {}),
          ...(input.guideMode ? { guideMode: input.guideMode } : {}),
        }),
      },
      {
        bearerToken: input.bearerToken,
        expectedUserId: input.expectedUserId,
      },
    );
    recordLocationRunStarted(result, { requestedRunId: runId });
    return result;
  }

  static findActive(
    auth: OneLocationRunAuthOptions = {},
  ): Promise<LocationOnboardingRunResultV1 | null> {
    return fetchOptionalRunResult(
      `${API_ROOT}/active`,
      { method: "GET" },
      auth,
    );
  }

  static get(
    runId: string,
    auth: OneLocationRunAuthOptions = {},
  ): Promise<LocationOnboardingRunResultV1> {
    const cleanRunId = exactToken(runId, 100, RUN_ID_PATTERN);
    if (!cleanRunId)
      return Promise.reject(new Error("Location task is invalid."));
    return fetchRunResult(
      `${API_ROOT}/${encodeURIComponent(cleanRunId)}`,
      { method: "GET" },
      auth,
    );
  }

  static async cancel(input: {
    run: LocationRunProjectionV1;
    bearerToken?: string | null;
    expectedUserId?: string;
  }): Promise<LocationOnboardingRunResultV1> {
    const suppliedRun = parseLocationRunProjection(input.run);
    if (!suppliedRun || TERMINAL_STATUSES.has(suppliedRun.status)) {
      throw new Error("Resume Location setup before cancelling it.");
    }
    const auth = {
      bearerToken: input.bearerToken,
      expectedUserId: input.expectedUserId,
    };
    // Refresh the owner-scoped projection before cancellation. The server is
    // still authoritative, but this avoids knowingly POSTing a stale cached
    // revision and keeps test teardown from cancelling a newer task state.
    const refreshed = await this.get(suppliedRun.runId, auth);
    if (
      refreshed.run.runId !== suppliedRun.runId ||
      refreshed.run.revision !== suppliedRun.revision ||
      TERMINAL_STATUSES.has(refreshed.run.status)
    ) {
      throw new Error("Location setup changed. Resume it before cancelling.");
    }
    const cancelled = await fetchRunResult(
      `${API_ROOT}/${encodeURIComponent(refreshed.run.runId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: refreshed.run.revision }),
      },
      auth,
    );
    if (
      cancelled.run.runId !== refreshed.run.runId ||
      cancelled.run.status !== "cancelled" ||
      cancelled.run.revision <= refreshed.run.revision ||
      cancelled.directive !== null
    ) {
      throw new Error("Agent One could not verify Location cancellation.");
    }
    return cancelled;
  }

  static async settle(input: {
    run: LocationRunProjectionV1;
    result: string;
    draftMetadata?: LocationPreVaultDraftMetadataV1 | null;
    positionObservation?: LocationPositionObservationV1 | null;
    bearerToken?: string | null;
  }): Promise<LocationOnboardingRunResultV1> {
    const suppliedRun = parseLocationRunProjection(input.run);
    const suppliedDirective = suppliedRun?.pendingDirective;
    if (!suppliedRun || !suppliedDirective) {
      throw new Error("Resume Location setup before continuing.");
    }
    // A session projection is presentation only. Re-read the owned run so
    // a forged/stale local directive can never be used as settlement authority.
    const auth = { bearerToken: input.bearerToken };
    const refreshed = await this.get(suppliedRun.runId, auth);
    const run = refreshed.run;
    const directive = refreshed.directive;
    const result = safeToken(input.result, 64);
    if (
      !directive ||
      directive.directiveId !== suppliedDirective.directiveId ||
      directive.contractId !== suppliedDirective.contractId ||
      directive.lease.leaseId !== suppliedDirective.lease.leaseId ||
      directive.lease.runRevision !== suppliedDirective.lease.runRevision ||
      !result ||
      !directive.allowedResults.includes(result) ||
      Date.parse(directive.expiresAt) <= Date.now()
    ) {
      throw new Error(
        "This Location step expired. Resume it before continuing.",
      );
    }
    const draftMetadata = input.draftMetadata ?? null;
    if (
      (result === "vault_unavailable" && !draftMetadata) ||
      (draftMetadata &&
        (result !== "vault_unavailable" ||
          draftMetadata.schemaVersion !==
            "one.location.pre_vault.draft_metadata.v1" ||
          draftMetadata.status !== "staged" ||
          !DRAFT_DIGEST_PATTERN.test(draftMetadata.digest) ||
          draftMetadata.runId !== run.runId ||
          draftMetadata.revision !== run.revision ||
          !Number.isFinite(Date.parse(draftMetadata.expiresAt)) ||
          Date.parse(draftMetadata.expiresAt) <= Date.now()))
    ) {
      throw new Error("Location draft metadata is invalid.");
    }
    const positionObservation = input.positionObservation
      ? parseLocationPositionObservation(input.positionObservation)
      : null;
    if (
      (result === "position_captured" && !positionObservation) ||
      (input.positionObservation && !positionObservation) ||
      (positionObservation && result !== "position_captured")
    ) {
      throw new Error("Location position observation is invalid.");
    }
    const next = await fetchRunResult(
      `${API_ROOT}/${encodeURIComponent(run.runId)}/interactions/${encodeURIComponent(directive.directiveId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          runRevision: directive.lease.runRevision,
          leaseId: directive.lease.leaseId,
          result,
          ...(draftMetadata ? { draftMetadata } : {}),
          ...(positionObservation ? { positionObservation } : {}),
        }),
      },
      auth,
    );
    recordLocationInteractionSettled({
      previousRun: run,
      result,
      next,
    });
    return next;
  }

  /**
   * Persist only a server-issued projection. This grants no authority; it is a
   * route-surviving presentation hint that must be refreshed before settling.
   */
  static async rememberProjection(
    userId: string,
    value: unknown,
    nowMs = Date.now(),
  ): Promise<LocationRunProjectionV1 | null> {
    const projection = parseLocationRunProjection(value);
    if (!projection) return null;
    const storage = browserStorage();
    if (!storage) return projection;
    try {
      const key = await cacheKey(userId);
      const previous = await this.readProjection(userId, nowMs);
      if (
        previous?.runId === projection.runId &&
        previous.revision > projection.revision
      ) {
        return previous;
      }
      const stored: StoredProjectionV2 = {
        ...projection,
        // Authorization is a bearer capability, unlike the presentation
        // projection. A relaunch must fetch a fresh server-issued copy.
        pkmFinalizeAuthorization: null,
        cacheVersion: CACHE_VERSION,
        cachedAtMs: nowMs,
        expiresAtMs: Math.min(
          nowMs + CACHE_TTL_MS,
          projection.pendingDirective
            ? Date.parse(projection.pendingDirective.expiresAt)
            : nowMs + CACHE_TTL_MS,
        ),
      };
      storage.setItem(key, JSON.stringify(stored));
    } catch {
      // Server state remains authoritative when presentation storage is
      // blocked, corrupt, or full. Never synthesize a fallback run.
    }
    return projection;
  }

  static async readProjection(
    userId: string,
    nowMs = Date.now(),
  ): Promise<LocationRunProjectionV1 | null> {
    const storage = browserStorage();
    if (!storage) return null;
    let key: string;
    try {
      key = await cacheKey(userId);
    } catch {
      return null;
    }
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const projection = storedProjection(JSON.parse(raw), nowMs);
      if (!projection) storage.removeItem(key);
      return projection;
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // Best-effort cleanup of a non-authoritative presentation cache.
      }
      return null;
    }
  }

  static async clearProjection(userId: string): Promise<void> {
    const storage = browserStorage();
    if (!storage) return;
    try {
      storage.removeItem(await cacheKey(userId));
    } catch {
      // The cache carries no authority or private workflow slots.
    }
  }

  static shouldOfferResume(projection: LocationRunProjectionV1): boolean {
    return !TERMINAL_STATUSES.has(projection.status);
  }

  /** Bound device work without pretending the underlying OS operation settled. */
  static settleWithin<T>(
    operation: Promise<T>,
    timeoutMs = ONE_LOCATION_INTERACTION_DEADLINE_MS,
  ): Promise<BoundedLocationInteractionResult<T>> {
    const boundedMs = Math.max(1, Math.min(timeoutMs, 30_000));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ status: "timed_out" });
      }, boundedMs);
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          resolve({ status: "settled", value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
