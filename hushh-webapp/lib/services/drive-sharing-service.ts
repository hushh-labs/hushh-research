import { traceDriveRequest, observeDriveRequestState } from "@/lib/consent/drive-request-diagnostics";
import { DriveSharingError, record, string, revision, digest, bulkCount, bulkText } from "@/lib/services/drive-sharing-wire";
import { parseAgentDocumentPackage, type AgentDocumentPackage } from "@/lib/services/drive-request-package-contract";
export { DriveSharingError } from "@/lib/services/drive-sharing-wire";
export type { AgentDocumentPackage } from "@/lib/services/drive-request-package-contract";
import { parseDrivePackageDisclosure, type DrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";
import type { DocumentRequestSetup } from "@/lib/consent/document-request-setup";
import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import {
  parseRequesterPaymentView,
  parseRequesterPriceView,
  type RequesterPaymentView,
  type RequesterPriceView,
} from "@/lib/consent/document-request-payment-view";
import {
  parseOwnerReviewRequest,
  parseRequesterRecovery,
  type OwnerReviewRequest,
  type RequesterRecovery,
} from "@/lib/consent/document-request-requester-view";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import {
  isDriveSearchSelectionReady,
  parseDriveSearchResults,
  parseDriveSearchStatus,
  type DriveSearchResults,
  type DriveSearchStatus,
} from "@/lib/services/drive-search-service";

export type SharingStatus = DocumentRequestSetup & {
  oneCopyRequested?: boolean;
  requestId: string;
  status: string;
  revision: number;
  direction: "incoming" | "outgoing";
  /** Additive new-contract routing; legacy replies omit it. */
  hostedDelivery?: true;
  outcomeReason?: "no_matching_files" | "matching_files_unshareable";
  /** Owner-only retained candidate counts; never delivery or grant evidence. */
  matchedFileCount?: number;
  unshareableFileCount?: number;
  requestedAccessDays?: number | null;
  approvedAccessDays?: number | null;
  accessExpiresAt?: string | null;
  /** The server's request-time quote, absent on legacy requests. */
  quotedAmountCents?: number;
  paymentRequired?: boolean;
  quoteVersion?: number;
  /** Requester only: the shared payment view; null when absent or malformed. */
  payment?: RequesterPaymentView | null;
  /** Requester only: estimate, current and final price; null when absent or malformed. */
  price?: RequesterPriceView | null;
} & DocumentRequestQueue;
/**
 * An allowed or Trusted request waiting in the durable queue with no search
 * started. Both fields are present together, or neither (older servers).
 */
export type DocumentRequestQueue = {
  /** When the request became due for the scheduled drain. */
  queuedAt?: string;
  /** Still waiting past the server's threshold; the request is saved and continues. */
  queueDelayed?: boolean;
  /**
   * Started work (a search or Drive grants) that no worker has moved past the
   * server's threshold, since this time. Absent while it moves. Never "paused".
   */
  workDelayedSince?: string;
  /** The request text names a longer span than its picked dates; the dates win. */
  periodConflict?: "request_mentions_longer_span";
  /** Trusted or allowed: every in-period match is sent after payment, no file picking. */
  autoshare?: boolean;
  /** Requester view: the owner has not allowed this request yet. */
  awaitingOwnerAllow?: boolean;
};
/** A decision's acknowledgement; a withdrawal also carries the payment view. */
export type SharingDecision = Record<string, unknown> & {
  payment?: RequesterPaymentView | null;
};
export type DocumentRequestDraft = {
  oneCopyRequested?: boolean;
  activityAccepted?: boolean;
  activityDisclosureVersion?: "one-document-activity-v1";
  ownerPersonRef: string;
  clientRequestId: string;
  /** Optimistic guard for the quote the requester saw before sending. */
  expectedQuoteVersion?: number | null;
  accessDays?: number;
  requesterActorType?: "person" | "ria";
  reason?: string;
  timeZone?: string;
  purpose: {
    purpose: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
};
export type SharingRequestContext = {
  requestRevision?: number;
  packageDisclosure?: DrivePackageDisclosure | null;
  requestId: string;
  purpose: DocumentRequestDraft["purpose"];
  /** The Google account files go to, as sealed when sent. Absent from older servers. */
  recipientEmail?: string | null;
  /** When the requester sent it (ISO). Absent from older servers. */
  requestedAt?: string | null;
  /** The requester's IANA time zone when they sent it, if recorded. */
  timeZone?: string | null;
};

export function validDocumentRequestPeriod(
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return start === null && end === null;
  const validDate = (value: string) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !value.startsWith("0000") &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  };
  return validDate(start) && validDate(end) && end >= start;
}

export function validDocumentRequestTerms(
  purpose: string,
  start: string | null,
  end: string | null,
): boolean {
  return (
    purpose.trim().length > 0 &&
    purpose.length <= 2000 &&
    start !== null &&
    end !== null &&
    validDocumentRequestPeriod(start, end)
  );
}
export type SharingReview = DocumentRequestSetup & {
  oneCopyRequested?: boolean;
  agentPackage?: AgentDocumentPackage;
  /** Live request evaluation lane; packet catalog requests use the legacy package view. */
  v1LiveRequest?: boolean;
  /** Machine-verified V1 files are offered through the existing owner file review. */
  v1ManualReview?: boolean;
  requesterProfile?: {
    type: "ria";
    displayName: string | null;
    legalName: string | null;
    crd: string | null;
    firmName: string | null;
  };
  reason?: string;
  requestedAccessDays?: number | null;
  approvedAccessDays?: number | null;
  accessExpiresAt?: string | null;
  verifiedCount?: number;
  revision: number;
  status: string;
  recipientEmail: string;
  purpose: {
    purpose: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
  files: { documentId: string; name: string }[];
  coverage: {
    summary: string;
    status: string;
    gaps: string[];
    truncated: boolean;
  } | null;
  reviewDigest: string | null;
  expiresAt: string | null;
  canApprove: boolean;
  canTrustFutureRequests: boolean;
  preparationError: SharingPreparationError | null;
  /** An eligible Trusted-circle request handled without per-request owner approval. */
  trustedAuto?: boolean;
  durableAvailable?: boolean;
  /** Present on servers with durable, request-bound Drive search. */
  search?: DriveSearchStatus | null;
  bulkShare?: DriveBulkShareView | null;
  /** Request-bound reviews, newest first. Each batch is at most 25 files. */
  batches?: DriveBulkShareView[];
  batchCount?: number;
  /** All positions already frozen in any batch for this request. */
  claimedPositions?: number[];
  /** Skipped automatic positions the owner may explicitly review after manual takeover. */
  recoverablePositions?: number[];
  progressiveAllowed?: boolean;
  aggregateCounts?: DriveBulkShareCounts;
  /** The owner allowed this request from outside their Trusted circle. */
  ownerAllowed?: boolean;
  /** The owner may Allow or Deny now. Nothing searches Drive before Allow. */
  allowAvailable?: boolean;
  /** Trusted request awaiting only its per-request price, never new consent. */
  priceOnlyAvailable?: boolean;
  /** The requester pays before files are shared, so Allow sets a price. */
  paymentRequired?: boolean;
  /** The owner's price in cents once allowed; null when there is none. */
  priceCents?: number | null;
  /** The estimate the requester saw when sending; absent when unknown or on older servers. */
  estimateCents?: number;
  /** Owner-only, current ledger projection for a paid document request. */
  ownerPayout?: OwnerDocumentPayout | null;
  /** This request accepts whole-dollar prices from $1 only; the server refuses others. */
  wholeDollarPrice?: boolean;
} & DocumentRequestQueue;
export type OwnerDocumentPayoutStatus =
  | "awaiting_delivery"
  | "awaiting_refund"
  | "awaiting_fee"
  | "awaiting_account"
  | "due"
  | "dispatching"
  | "unknown"
  | "manual_review"
  | "transferred"
  | "hashcoins_credited"
  | "hashcoins_held"
  | "hashcoins_reversed"
  | "reversal_due"
  | "reversal_unknown"
  | "reversed"
  | "void";
export type OwnerDocumentPayout = {
  requestId: string;
  currency: "usd";
  grossAmountCents: number;
  retainedAmountCents: number | null;
  platformFeeCents: number | null;
  processingFeeCents: number | null;
  ownerEarningCents: number | null;
  status: OwnerDocumentPayoutStatus;
};
export type SharingAllowInput = {
  oneCopyAccepted?: boolean;
  revision: number;
  amountCents: number | null;
} & ({ packageRevision: number; packageDigest: string } |
  { packageRevision?: never; packageDigest?: never });
export type SharingAllowResult = { requestId: string; status: string; revision: number };
const SHARING_PREPARATION_ERRORS = [
  "package_existing_access_requires_review",
  "payment_not_ready",
  "no_relevant_files",
  "no_ready_files",
  "narrow_selection_required",
  "source_changed",
  "preparation_unavailable",
  "trust_revoked",
  "background_preparation_required",
  "trusted_relationship_changed",
  "date_range_required",
  "owner_price_required",
  "owner_payout_required",
  "payout_unavailable",
] as const;
/** Why preparation ended without suggestions. Unknown codes are dropped. */
export type SharingPreparationError =
  (typeof SHARING_PREPARATION_ERRORS)[number];
function preparationError(value: unknown): SharingPreparationError | null {
  return (SHARING_PREPARATION_ERRORS as readonly unknown[]).includes(value)
    ? (value as SharingPreparationError)
    : null;
}
function parseRequestSetup(value: Record<string, unknown>): DocumentRequestSetup {
  const ownerDriveReady = optionalFlag(value.ownerDriveReady);
  const ownerPriceRequired = optionalFlag(value.ownerPriceRequired);
  const ownerPayoutAccountReady = optionalFlag(value.ownerPayoutAccountReady);
  const paymentsReady = optionalFlag(value.paymentsReady);
  return {
    ...(ownerDriveReady === undefined ? {} : { ownerDriveReady }),
    ...(ownerPriceRequired === undefined ? {} : { ownerPriceRequired }),
    ...(ownerPayoutAccountReady === undefined ? {} : { ownerPayoutAccountReady }),
    ...(paymentsReady === undefined ? {} : { paymentsReady }),
  };
}
export type SharingDelivery = {
  status: string;
  noChargeReason?: "existing_access";
  accessStopStatus?: "pending" | "removed" | "needs_attention" | null;
  canStopAccess?: boolean;
  files: SharingDeliveryFile[];
  fileCount?: number;
  sharedCount?: number;
  bulkShareId?: string | null;
  bulkStatus?: DriveBulkShareView["status"];
  counts?: DriveBulkShareCounts;
  issues?: DriveBulkShareIssue[];
  /** Requester only: estimate, owner price and final price; null when malformed. */
  price?: RequesterPriceView | null;
  /** Requester only: undelivered files, the owner-retry state and their refund. */
  recovery?: RequesterRecovery | null;
  /** Owner only: the requester asked for a review of unshared files. */
  reviewRequest?: OwnerReviewRequest | null;
};
function accessStopStatus(value: unknown): NonNullable<SharingDelivery["accessStopStatus"]> {
  if (value === "pending" || value === "removed" || value === "needs_attention") return value;
  throw new DriveSharingError("invalid_response");
}
function canStopAccess(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new DriveSharingError("invalid_response");
}
export type SharingDeliveryFile = {
    name: string;
    status: string;
    revocationStatus: string | null;
    grantId: string | null;
    managed: boolean;
    openUrl: string | null;
    manageInGoogle: boolean;
};
export type SharingDeliveryFilePage = {
  files: SharingDeliveryFile[];
  nextCursor: string | null;
};
export type SharingRevocationReview = {
  revision: number;
  directiveId: string;
  reviewDigest: string;
  expiresAt: string;
  files: { grantId: string; name: string; recipientEmail: string }[];
  affectedCount?: number;
  pendingCount?: number;
};
export type TrustedDocumentRule = {
  ruleId: string;
  version: number;
  recipientEmail: string;
  purpose: { purpose: string; periodStart: string | null; periodEnd: string | null };
  fileNames: string[];
  scope: "exact_files_same_request_purpose" | "any_requested_drive_file";
  readiness: "ready" | "background_off" | "reconnect_required";
  status: "Trusted for documents";
};

export type DriveQueryStatus =
  | "pending"
  | "running"
  | "answered"
  | "denied"
  | "cancelled"
  | "expired";
/** One connection's question about the owner's Drive. No file ids or links. */
export type DriveQueryView = {
  requestId: string;
  direction: "incoming" | "outgoing";
  status: DriveQueryStatus;
  revision: number;
  query: string;
  counterpartName: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  answer: {
    text: string;
    titles: string[];
    truncated: boolean;
    // Owner only: the files found for this question, by reference, never Drive ids.
    files: DriveQueryFile[];
    // Set once the owner shared files from this answer.
    shareRequestId: string | null;
    // Owner only: the exact selection reserved by an attempted share.
    selectedFileRefs?: string[] | null;
  } | null;
  canDecide: boolean;
  lastError: "reconnect_required" | "drive_query_unavailable" | null;
};
export type DriveQueryFile = {
  ref: string;
  name: string;
  modifiedTime: string | null;
};
export type DriveQueryDraft = { clientRequestId: string; query: string } & (
  | { ownerPersonRef: string; ownerUserId?: never }
  | { ownerUserId: string; ownerPersonRef?: never }
);
export type DriveQueryPage = { items: DriveQueryView[]; hasMore: boolean };

export const DRIVE_QUERY_MAX_CHARS = 2000;
export const DRIVE_QUERY_MAX_BYTES = 2048;

/** Mirrors the server bound: non-blank, 2000 characters and 2048 UTF-8 bytes. */
export function validDriveQuery(query: string): boolean {
  return (
    query.trim().length > 0 &&
    query.length <= DRIVE_QUERY_MAX_CHARS &&
    new TextEncoder().encode(query).length <= DRIVE_QUERY_MAX_BYTES
  );
}

/** The streamed route is unavailable here (older backend or native build). */
export class StreamUnavailable extends Error {
  constructor() {
    super("Streamed preparation is unavailable.");
  }
}
/** Public preparation stages, in order. Never file names, ids or coverage. */
export const PREPARE_STAGES = ["starting", "searching", "choosing", "checking"] as const;
export type PrepareStage = (typeof PREPARE_STAGES)[number];
export type PrepareOutcome =
  | "review_ready"
  | "no_ready_files"
  | "unavailable"
  | "not_claimed"
  // The stream ended without a result; status is the truth.
  | "interrupted";
const PREPARE_RESULTS = new Set<string>([
  "review_ready",
  "no_ready_files",
  "unavailable",
  "not_claimed",
]);
// The codes drive_sharing.py _error() can send. A client-internal code such as
// session_changed or request_failed is never accepted from the server.
const STREAM_ERROR_CODES = new Set<string>([
  "request_unavailable",
  "verify_google_identity_required",
  "review_changed",
  "source_changed",
  "recipient_changed",
  "reconnect_required",
  "connection_changed",
  "connection_required",
  "explicit_approval_required",
  "confirmation_required",
  "request_already_decided",
  "request_changed",
  "revocation_pending",
  "no_revocable_permissions",
  "sharing_unavailable",
  "rule_not_covered",
  "rule_changed",
  "connector_unavailable",
  "request_expired",
  "owner_share_expired",
  "drive_query_unavailable",
  "recipient_google_identity_required",
  "recipient_verified_email_required",
  "recipient_verification_unavailable",
  "drive_share_unavailable",
  "drive_share_in_progress",
  "bulk_not_found",
  "bulk_expired",
  "bulk_conflict",
  "bulk_changed",
  "search_in_progress",
  "search_incomplete",
  "search_not_found",
  "no_recipients",
  "invalid_argument",
]);
const STREAM_FRAME_MAX_LENGTH = 1024;
function unimplemented(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "UNIMPLEMENTED"
  );
}
type RecordValue = Record<string, unknown>;
export type SharingSessionGuard = (() => void) & { canDispatch?: () => boolean };
function id(value: unknown): string {
  const result = string(value, 36);
  if (!DOCUMENT_REQUEST_UUID.test(result))
    throw new DriveSharingError("invalid_response");
  return result;
}
function files<T>(value: unknown, parse: (item: RecordValue) => T): T[] {
  if (!Array.isArray(value) || value.length > 25)
    throw new DriveSharingError("invalid_response");
  return value.map((item) => parse(record(item)));
}
function date(value: unknown): string {
  const result = string(value, 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new DriveSharingError("invalid_response");
  return result;
}

const SHARING_PATH = "/api/connectors/google_drive/sharing";
const VIEW_MAX_LENGTH = 64 * 1024;
const QUERY_PAGE_MAX = 50;
const QUERY_STATUSES = new Set<DriveQueryStatus>([
  "pending",
  "running",
  "answered",
  "denied",
  "cancelled",
  "expired",
]);

const QUERY_FILE_REF = /^f[1-8]$/;

/** Only the owner ever receives the found files; the asker's view must not carry them. */
function queryFiles(value: unknown, direction: string): DriveQueryFile[] {
  if (value == null) return [];
  if (direction !== "incoming" || !Array.isArray(value) || value.length > 8)
    throw new DriveSharingError("invalid_response");
  const files = value.map((item) => {
    const file = record(item);
    const ref = string(file.ref, 3);
    if (!QUERY_FILE_REF.test(ref)) throw new DriveSharingError("invalid_response");
    return {
      ref,
      name: string(file.name, 1024),
      modifiedTime: file.modifiedTime == null ? null : date(file.modifiedTime),
    };
  });
  if (new Set(files.map((file) => file.ref)).size !== files.length)
    throw new DriveSharingError("invalid_response");
  return files;
}

/** Strict decode: any unexpected shape fails closed instead of rendering. */
export function parseDriveQueryView(value: unknown): DriveQueryView {
  const result = record(value);
  const direction = result.direction;
  if (direction !== "incoming" && direction !== "outgoing")
    throw new DriveSharingError("invalid_response");
  const status = result.status as DriveQueryStatus;
  if (!QUERY_STATUSES.has(status))
    throw new DriveSharingError("invalid_response");
  const rawAnswer = result.answer == null ? null : record(result.answer);
  // An answer exists exactly when the question was answered.
  if ((rawAnswer !== null) !== (status === "answered"))
    throw new DriveSharingError("invalid_response");
  if (
    rawAnswer &&
    (!Array.isArray(rawAnswer.titles) ||
      rawAnswer.titles.length > 25 ||
      typeof rawAnswer.truncated !== "boolean")
  )
    throw new DriveSharingError("invalid_response");
  const lastError = result.lastError ?? null;
  if (
    lastError !== null &&
    lastError !== "reconnect_required" &&
    lastError !== "drive_query_unavailable"
  )
    throw new DriveSharingError("invalid_response");
  const answerFiles = rawAnswer ? queryFiles(rawAnswer.files, direction) : [];
  const selectedFileRefs = rawAnswer?.selectedFileRefs;
  if (selectedFileRefs != null && (
    direction !== "incoming" || !Array.isArray(selectedFileRefs) ||
    selectedFileRefs.length < 1 || selectedFileRefs.length > 8 ||
    new Set(selectedFileRefs).size !== selectedFileRefs.length ||
    selectedFileRefs.some((ref) => typeof ref !== "string" || !answerFiles.some((file) => file.ref === ref))
  ))
    throw new DriveSharingError("invalid_response");
  return {
    requestId: id(result.requestId),
    direction,
    status,
    revision: revision(result.revision),
    query: string(result.query, DRIVE_QUERY_MAX_CHARS),
    counterpartName:
      result.counterpartName == null
        ? null
        : string(result.counterpartName, 320),
    createdAt: date(result.createdAt),
    expiresAt: date(result.expiresAt),
    decidedAt: result.decidedAt == null ? null : date(result.decidedAt),
    answer: rawAnswer
      ? {
          text: string(rawAnswer.text, 20_000),
          titles: (rawAnswer.titles as unknown[]).map((title) =>
            string(title, 1024),
          ),
          truncated: rawAnswer.truncated as boolean,
          files: answerFiles,
          ...(selectedFileRefs == null ? {} : { selectedFileRefs: selectedFileRefs as string[] }),
          shareRequestId:
            rawAnswer.shareRequestId == null ? null : id(rawAnswer.shareRequestId),
        }
      : null,
    // Only the owner of a pending question may ever decide it.
    canDecide:
      result.canDecide === true &&
      direction === "incoming" &&
      status === "pending",
    // The owner's connection state is never shown to the person asking.
    lastError: direction === "incoming" ? lastError : null,
  };
}

/** The owner's own Drive search for sharing with a connection, from chat. */
export type DriveOwnerShareView = {
  requestId: string | null;
  status: "ready" | "shared" | "no_match";
  recipientName: string | null;
  files: DriveQueryFile[];
  shareRequestId: string | null;
  /** The owner's own search words when nothing matched (e.g. "Which file?"). */
  message: string | null;
  selectedFileRefs?: string[] | null;
  selectionExpired?: boolean;
};

function ownerSelection(value: RecordValue, files: DriveQueryFile[]) {
  const refs = value.selectedFileRefs;
  if (refs != null && (!Array.isArray(refs) || refs.length < 1 || refs.length > 8 ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => typeof ref !== "string" || !files.some((file) => file.ref === ref))))
    throw new DriveSharingError("invalid_response");
  if (value.selectionExpired !== undefined && typeof value.selectionExpired !== "boolean")
    throw new DriveSharingError("invalid_response");
  if (value.selectionExpired === true && refs == null)
    throw new DriveSharingError("invalid_response");
  return {
    selectedFileRefs: refs == null ? null : refs as string[],
    selectionExpired: value.selectionExpired === true,
  };
}

function parseOwnerShareView(value: RecordValue): DriveOwnerShareView {
  const status = string(value.status, 16);
  if (status !== "ready" && status !== "shared" && status !== "no_match")
    throw new DriveSharingError("invalid_response");
  if (status === "no_match") {
    return {
      requestId: null,
      status,
      recipientName: null,
      files: [],
      shareRequestId: null,
      message: value.message == null ? null : string(value.message, 600),
    };
  }
  const found = queryFiles(value.files, "incoming");
  if (!found.length) throw new DriveSharingError("invalid_response");
  return {
    requestId: id(value.requestId),
    status,
    recipientName:
      value.recipientName == null ? null : string(value.recipientName, 200),
    files: found,
    shareRequestId: value.shareRequestId == null ? null : id(value.shareRequestId),
    message: null,
    ...ownerSelection(value, found),
  };
}

/** Why a Trusted circle member cannot receive a circle share (closed set). */
export type DriveCircleExclusion =
  | "not_connected"
  | "contacts"
  | "circle"
  | "imported"
  | "unavailable"
  | "no_google_account"
  | "no_verified_email"
  | "limit";
const CIRCLE_EXCLUSIONS = new Set<DriveCircleExclusion>([
  "not_connected",
  "contacts",
  "circle",
  "imported",
  "unavailable",
  "no_google_account",
  "no_verified_email",
  "limit",
]);

/** The owner's own search for sharing with their Trusted circle, from chat. */
export type DriveCircleShareView = {
  status: "ready" | "shared" | "no_match" | "no_recipients";
  files: DriveQueryFile[];
  recipients: Array<{
    requestId: string;
    name: string | null;
    status: "ready" | "shared";
    shareRequestId: string | null;
    selectedFileRefs?: string[] | null;
    selectionExpired?: boolean;
  }>;
  excluded: Array<{ name: string | null; reason: DriveCircleExclusion }>;
  message: string | null;
};

function parseCircleShareView(value: RecordValue): DriveCircleShareView {
  const status = string(value.status, 16);
  if (
    status !== "ready" &&
    status !== "shared" &&
    status !== "no_match" &&
    status !== "no_recipients"
  )
    throw new DriveSharingError("invalid_response");
  if (!Array.isArray(value.recipients) || value.recipients.length > 10)
    throw new DriveSharingError("invalid_response");
  if (!Array.isArray(value.excluded) || value.excluded.length > 100)
    throw new DriveSharingError("invalid_response");
  const files =
    status === "ready" || status === "shared" ? queryFiles(value.files, "incoming") : [];
  const recipients = value.recipients.map((item) => {
    const row = record(item);
    const rowStatus = string(row.status, 8);
    if (rowStatus !== "ready" && rowStatus !== "shared")
      throw new DriveSharingError("invalid_response");
    return {
      requestId: id(row.requestId),
      name: row.name == null ? null : string(row.name, 200),
      status: rowStatus as "ready" | "shared",
      shareRequestId: row.shareRequestId == null ? null : id(row.shareRequestId),
      ...ownerSelection(row, files),
    };
  });
  const excluded = value.excluded.map((item) => {
    const row = record(item);
    const reason = string(row.reason, 32) as DriveCircleExclusion;
    if (!CIRCLE_EXCLUSIONS.has(reason)) throw new DriveSharingError("invalid_response");
    return { name: row.name == null ? null : string(row.name, 200), reason };
  });
  if ((status === "ready" || status === "shared") && (!files.length || !recipients.length))
    throw new DriveSharingError("invalid_response");
  return {
    status,
    files,
    recipients,
    excluded,
    message: value.message == null ? null : string(value.message, 600),
  };
}

export type DriveBulkShareCounts = {
  total: number;
  processed: number;
  shared: number;
  alreadyShared: number;
  skipped: number;
  failed: number;
  needsReview: number;
  unknown: number;
  pending: number;
};
const BULK_REASON_CODES = [
  "source_changed", "source_not_shareable", "recipient_changed", "connection_changed", "stopped",
  "sharing_unavailable", "date_range_required", "retry_limit", "provider_unavailable", "permission_rejected",
  "permission_outcome_unknown", "permission_catalog_incomplete", "sharing_rate_limited",
  "recipient_needs_google_account", "drive_policy_blocked", "unavailable",
] as const;
export type DriveBulkReasonCode = (typeof BULK_REASON_CODES)[number];
export type DriveBulkShareIssue = { reasonCode: DriveBulkReasonCode; count: number };
const BULK_OUTCOME_STATES = [
  "queued", "dispatching", "unknown", "succeeded", "preexisting", "skipped", "failed", "present_unattributed", "absent",
] as const;
export type DriveBulkFileOutcome = {
  status: (typeof BULK_OUTCOME_STATES)[number];
  reasonCode: DriveBulkReasonCode | null;
};
/** A frozen, owner-reviewed search result set. Counts are file-recipient effects. */
export type DriveBulkShareView = {
  shareId: string;
  searchJobId: string;
  status: "review_ready" | "queued" | "running" | "completed" | "partial" | "stopped" | "failed";
  revision: number;
  reviewDigest: string;
  fileCount: number;
  /** Owner-only positions frozen from the request search for this batch. */
  positions?: number[];
  recipientCount: number;
  recipients: Array<{ name: string | null; email: string }>;
  excluded: Array<{ name: string | null; reason: DriveCircleExclusion }>;
  counts: DriveBulkShareCounts;
  issues?: DriveBulkShareIssue[];
  notifications: { settled: number; pending: number; unavailable: number };
  canApprove: boolean;
  canStop: boolean;
  canRetry?: boolean;
  retryableCount?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type DriveBulkShareFilePage = {
  shareId: string;
  files: Array<{ position: number; name: string; mimeType: string; modifiedTime: string | null; openUrl: string | null;
    outcomes?: DriveBulkFileOutcome[] }>;
  nextCursor: string | null;
};

export type ReceivedDriveBulkShare = {
  shareId: string;
  status: DriveBulkShareView["status"];
  sharedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ReceivedDriveBulkFilesPage = {
  shareId: string;
  sharedCount: number;
  files: Array<{ name: string; openUrl: string | null; modifiedTime: string | null }>;
  nextCursor: string | null;
};

const BULK_STATUSES = new Set<DriveBulkShareView["status"]>([
  "review_ready", "queued", "running", "completed", "partial", "stopped", "failed",
]);



function bulkStatus(value: unknown): DriveBulkShareView["status"] {
  const status = bulkText(value, 20) as DriveBulkShareView["status"];
  if (!BULK_STATUSES.has(status)) throw new DriveSharingError("invalid_response");
  return status;
}

function bulkReason(value: unknown): DriveBulkReasonCode {
  if (!(BULK_REASON_CODES as readonly unknown[]).includes(value))
    throw new DriveSharingError("invalid_response");
  return value as DriveBulkReasonCode;
}

function parseBulkCounts(value: unknown, total: number): DriveBulkShareCounts {
  const counts = record(value);
  const result = {
    total: bulkCount(counts.total), processed: bulkCount(counts.processed),
    shared: bulkCount(counts.shared), alreadyShared: bulkCount(counts.alreadyShared),
    skipped: bulkCount(counts.skipped), failed: bulkCount(counts.failed),
    needsReview: bulkCount(counts.needsReview), unknown: bulkCount(counts.unknown),
    pending: bulkCount(counts.pending),
  };
  const settled = result.shared + result.alreadyShared + result.skipped + result.failed + result.needsReview;
  if (result.total !== total || result.processed !== settled || settled + result.unknown + result.pending !== total)
    throw new DriveSharingError("invalid_response");
  return result;
}

const SEARCH_PROGRESS_FIELDS = [
  "batches", "batchCount", "claimedPositions", "recoverablePositions", "aggregateCounts", "progressiveAllowed",
] as const;

/**
 * Before a request's Drive search starts, older servers send empty progress beside
 * `search: null`. It means "no search yet"; any recorded progress is refused.
 */
function withoutEmptySearchProgress(value: RecordValue): RecordValue {
  const empty = (list: unknown) => list === undefined || Array.isArray(list) && list.length === 0;
  if (!empty(value.batches) || !empty(value.claimedPositions) || !empty(value.recoverablePositions) ||
    value.batchCount !== undefined && value.batchCount !== 0 ||
    value.progressiveAllowed !== undefined && typeof value.progressiveAllowed !== "boolean")
    throw new DriveSharingError("invalid_response");
  if (value.aggregateCounts !== undefined) parseBulkCounts(value.aggregateCounts, 0);
  const result = { ...value };
  for (const field of SEARCH_PROGRESS_FIELDS) delete result[field];
  return result;
}

/** Additive queue fields; a malformed value is dropped, never a failed read. */
function parseRequestQueue(result: Record<string, unknown>): DocumentRequestQueue {
  const { queuedAt, queueDelayed, workDelayedSince } = result;
  return {
    ...(typeof queuedAt === "string" && !Number.isNaN(Date.parse(queuedAt)) &&
      typeof queueDelayed === "boolean" ? { queuedAt, queueDelayed } : {}),
    ...(typeof workDelayedSince === "string" && !Number.isNaN(Date.parse(workDelayedSince))
      ? { workDelayedSince } : {}),
    ...(result.periodConflict === "request_mentions_longer_span"
      ? { periodConflict: "request_mentions_longer_span" as const } : {}),
    ...(result.autoshare === true ? { autoshare: true } : {}),
    ...(result.awaitingOwnerAllow === true ? { awaitingOwnerAllow: true } : {}),
  };
}

/** Absent on older servers; otherwise strictly a boolean. */
function optionalFlag(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new DriveSharingError("invalid_response");
}

function optionalPrice(value: unknown): number | null | undefined {
  if (value === undefined || value === null || isValidDocumentRequestPriceCents(value)) return value;
  throw new DriveSharingError("invalid_response");
}

const OWNER_PAYOUT_STATUSES = new Set<OwnerDocumentPayoutStatus>([
  "awaiting_delivery", "awaiting_refund", "awaiting_fee", "awaiting_account",
  "due", "dispatching", "unknown", "manual_review", "transferred", "hashcoins_credited", "hashcoins_held", "hashcoins_reversed",
  "reversal_due", "reversal_unknown", "reversed", "void",
]);

function ownerPayoutAmount(value: unknown): number | null {
  if (value === null) return null;
  return bulkCount(value, 50_000);
}

function parseOwnerPayout(value: unknown, requestId: string): OwnerDocumentPayout {
  const payout = record(value);
  const status = string(payout.status, 24) as OwnerDocumentPayoutStatus;
  if (id(payout.requestId) !== requestId || payout.currency !== "usd" ||
      !OWNER_PAYOUT_STATUSES.has(status))
    throw new DriveSharingError("invalid_response");
  return {
    requestId,
    currency: "usd",
    grossAmountCents: bulkCount(payout.grossAmountCents, 50_000),
    retainedAmountCents: ownerPayoutAmount(payout.retainedAmountCents),
    platformFeeCents: ownerPayoutAmount(payout.platformFeeCents),
    processingFeeCents: ownerPayoutAmount(payout.processingFeeCents),
    ownerEarningCents: ownerPayoutAmount(payout.ownerEarningCents),
    status,
  };
}

function parseBulkIssues(value: unknown, total: number): DriveBulkShareIssue[] {
  if (!Array.isArray(value) || value.length > BULK_REASON_CODES.length) throw new DriveSharingError("invalid_response");
  const issues = value.map(item => {
    const row = record(item);
    const count = bulkCount(row.count);
    if (!count || count > total) throw new DriveSharingError("invalid_response");
    return { reasonCode: bulkReason(row.reasonCode), count };
  });
  if (new Set(issues.map(item => item.reasonCode)).size !== issues.length ||
    issues.reduce((sum, item) => sum + item.count, 0) > total)
    throw new DriveSharingError("invalid_response");
  return issues;
}

/**
 * `issues` holds only codes every released client knows; a newer code arrives
 * there as its nearest known one. The exact codes come in the additive
 * `issueDetails`, used only when this client knows every one of them.
 */
function exactIssues(value: RecordValue, total: number): DriveBulkShareIssue[] {
  const known = parseBulkIssues(value.issues, total);
  if (value.issueDetails === undefined) return known;
  const sum = (issues: DriveBulkShareIssue[]) => issues.reduce((count, item) => count + item.count, 0);
  try {
    const exact = parseBulkIssues(value.issueDetails, total);
    return sum(exact) === sum(known) ? exact : known;
  } catch {
    return known;
  }
}

/** A file's exact additive code when this client knows it; else its known code. */
function exactReason(outcome: RecordValue): DriveBulkReasonCode | null {
  if (outcome.reasonCode == null) return null;
  const known = bulkReason(outcome.reasonCode);
  return (BULK_REASON_CODES as readonly unknown[]).includes(outcome.reasonDetail)
    ? outcome.reasonDetail as DriveBulkReasonCode : known;
}

function parseBulkShareView(value: RecordValue): DriveBulkShareView {
  const status = bulkStatus(value.status);
  if (typeof value.canApprove !== "boolean" || typeof value.canStop !== "boolean" ||
    !Array.isArray(value.recipients) || value.recipients.length > 10 ||
    !Array.isArray(value.excluded) || value.excluded.length > 100)
    throw new DriveSharingError("invalid_response");
  const notifications = record(value.notifications);
  const fileCount = bulkCount(value.fileCount, 10_000);
  const positions = value.positions === undefined ? undefined : (() => {
    if (!Array.isArray(value.positions) || value.positions.length !== fileCount || value.positions.length > 25)
      throw new DriveSharingError("invalid_response");
    const parsed = value.positions.map(position => bulkCount(position, 10_000));
    if (parsed.includes(0) || new Set(parsed).size !== parsed.length)
      throw new DriveSharingError("invalid_response");
    return parsed;
  })();
  const recipientCount = bulkCount(value.recipientCount, 10);
  const total = fileCount * recipientCount;
  if (value.canRetry !== undefined && typeof value.canRetry !== "boolean")
    throw new DriveSharingError("invalid_response");
  const retryableCount = value.retryableCount === undefined ? 0 : bulkCount(value.retryableCount, total);
  if (value.canRetry === true && (!retryableCount || !["partial", "failed"].includes(status)))
    throw new DriveSharingError("invalid_response");
  const recipients = value.recipients.map(item => {
    const row = record(item);
    return { name: row.name == null ? null : bulkText(row.name, 200), email: bulkText(row.email, 320) };
  });
  const excluded = value.excluded.map(item => {
    const row = record(item);
    const reason = bulkText(row.reason, 32) as DriveCircleExclusion;
    if (!CIRCLE_EXCLUSIONS.has(reason)) throw new DriveSharingError("invalid_response");
    return { name: row.name == null ? null : bulkText(row.name, 200), reason };
  });
  const result: DriveBulkShareView = {
    shareId: id(value.shareId), searchJobId: id(value.searchJobId), status,
    revision: revision(value.revision), reviewDigest: digest(value.reviewDigest),
    fileCount, recipientCount,
    ...(positions === undefined ? {} : { positions }),
    recipients, excluded,
    counts: parseBulkCounts(value.counts, total),
    ...(value.issues === undefined ? {} : { issues: exactIssues(value, total) }),
    notifications: { settled: bulkCount(notifications.settled, 10), pending: bulkCount(notifications.pending, 10),
      unavailable: bulkCount(notifications.unavailable, 10) },
    canApprove: value.canApprove, canStop: value.canStop,
    canRetry: value.canRetry === true, retryableCount,
    createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), expiresAt: date(value.expiresAt),
  };
  if (result.recipientCount !== recipients.length || result.counts.processed > result.counts.total ||
    result.counts.pending > result.counts.total || result.counts.unknown > result.counts.total ||
    (result.status !== "review_ready" && result.canApprove))
    throw new DriveSharingError("invalid_response");
  return result;
}

function parseBulkFilePage(value: RecordValue): DriveBulkShareFilePage {
  if (!Array.isArray(value.files) || value.files.length > 25) throw new DriveSharingError("invalid_response");
  const files = value.files.map(item => {
    const row = record(item);
    let openUrl: string | null = null;
    if (row.openUrl != null) {
      let url: URL;
      try { url = new URL(bulkText(row.openUrl, 2048)); } catch { throw new DriveSharingError("invalid_response"); }
      if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) ||
        url.username || url.password || url.port) throw new DriveSharingError("invalid_response");
      openUrl = url.href;
    }
    const position = bulkCount(row.position, 10_000);
    if (position === 0) throw new DriveSharingError("invalid_response");
    if (row.outcomes !== undefined && (!Array.isArray(row.outcomes) || row.outcomes.length > 10))
      throw new DriveSharingError("invalid_response");
    const outcomes = row.outcomes === undefined ? undefined : (row.outcomes as unknown[]).map(item => {
      const outcome = record(item);
      if (!(BULK_OUTCOME_STATES as readonly unknown[]).includes(outcome.status))
        throw new DriveSharingError("invalid_response");
      return { status: outcome.status as DriveBulkFileOutcome["status"], reasonCode: exactReason(outcome) };
    });
    return { position, name: bulkText(row.name, 1000), mimeType: bulkText(row.mimeType, 256),
      modifiedTime: row.modifiedTime == null ? null : date(row.modifiedTime), openUrl,
      ...(outcomes === undefined ? {} : { outcomes }) };
  });
  if (new Set(files.map(item => item.position)).size !== files.length)
    throw new DriveSharingError("invalid_response");
  return { shareId: id(value.shareId), files,
    nextCursor: value.nextCursor == null ? null : bulkText(value.nextCursor, 1024) };
}

function parseDeliveryFile(file: RecordValue): SharingDeliveryFile {
  const openUrl = file.openUrl == null ? null : string(file.openUrl, 512);
  if (openUrl && !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(openUrl))
    throw new DriveSharingError("invalid_response");
  return {
    name: string(file.name, 1024),
    status: string(file.status, 80),
    revocationStatus: file.revocationStatus == null ? null : string(file.revocationStatus, 80),
    grantId: file.grantId == null ? null : id(file.grantId),
    managed: file.managed === true,
    openUrl,
    manageInGoogle: file.manageInGoogle === true,
  };
}

function bulkFileUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(bulkText(value, 2048)); } catch { throw new DriveSharingError("invalid_response"); }
  if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) ||
    url.username || url.password || url.port) throw new DriveSharingError("invalid_response");
  return url.href;
}

/** Private responses stay in the invoking component's memory, never a cache. */
export class DriveSharingService {
  private static async request(
    token: string,
    requestId: string | null,
    guard: SharingSessionGuard,
    action = "",
    body?: object,
    firebaseToken?: string,
  ): Promise<RecordValue> {
    if (requestId !== null) id(requestId);
    return this.send(
      `${SHARING_PATH}/requests${requestId === null ? action : `/${requestId}${action}`}`,
      token,
      guard,
      body,
      firebaseToken,
    );
  }

  private static send(path: string, token: string, guard: SharingSessionGuard, body?: object, firebaseToken?: string, maxLength?: number, allowNull?: false): Promise<RecordValue>;
  private static send(path: string, token: string, guard: SharingSessionGuard, body: object | undefined, firebaseToken: string | undefined, maxLength: number, allowNull: true): Promise<RecordValue | null>;
  private static async send(
    path: string,
    token: string,
    guard: SharingSessionGuard,
    body?: object,
    firebaseToken?: string,
    maxLength = VIEW_MAX_LENGTH,
    allowNull = false,
  ): Promise<RecordValue | null> {
    guard();
    return traceDriveRequest(path, body === undefined ? "GET" : "POST", async (diagnosticHeaders, observe) => {
      guard();
      const response = await ApiService.apiFetch(
        path,
        {
          isEffectCurrent: () => {
            guard();
            return guard.canDispatch?.() !== false;
          },
          method: body === undefined ? "GET" : "POST",
          cache: "no-store",
          headers: {
            ...(firebaseToken
              ? {
                  Authorization: `Bearer ${firebaseToken}`,
                  "X-Hushh-Consent": token,
                }
              : ApiService.getAuthHeaders(token)),
            "Content-Type": "application/json",
            ...diagnosticHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      guard();
      observe(response);
      const serialized = await response.text();
      guard();
      if (serialized.length > maxLength)
        throw new DriveSharingError("invalid_response");
      let payload: RecordValue;
      try {
        const parsed: unknown = JSON.parse(serialized);
        if (parsed === null && allowNull && response.ok) return null;
        payload = record(parsed);
      } catch {
        throw new DriveSharingError("invalid_response", response.status);
      }
      observe(response, payload);
      if (!response.ok) {
        const detail =
          payload.detail && typeof payload.detail === "object"
            ? record(payload.detail)
            : payload;
        const code =
          typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code)
            ? detail.code
            : "request_failed";
        // Never render arbitrary provider/HTTP messages or log response contents.
        throw new DriveSharingError(code, response.status);
      }
      return payload;
    }, body);
  }

  static async create(
    token: string,
    firebaseToken: string,
    draft: DocumentRequestDraft,
    guard: SharingSessionGuard,
  ) {
    id(draft.ownerPersonRef);
    id(draft.clientRequestId);
    if (
      !firebaseToken ||
      (draft.oneCopyRequested === true && (draft.activityAccepted !== true || draft.activityDisclosureVersion !== "one-document-activity-v1")) ||
      (draft.expectedQuoteVersion !== undefined && draft.expectedQuoteVersion !== null &&
        (!Number.isSafeInteger(draft.expectedQuoteVersion) || draft.expectedQuoteVersion < 0)) ||
      (draft.accessDays !== undefined &&
        (!Number.isSafeInteger(draft.accessDays) || draft.accessDays < 1 || draft.accessDays > 90)) ||
      (draft.requesterActorType !== undefined &&
        draft.requesterActorType !== "person" && draft.requesterActorType !== "ria") ||
      (draft.reason !== undefined &&
        (typeof draft.reason !== "string" || draft.reason.length > 500)) ||
      (draft.requesterActorType === "ria" && !draft.reason?.trim()) ||
      !validDocumentRequestTerms(
        draft.purpose.purpose,
        draft.purpose.periodStart,
        draft.purpose.periodEnd,
      )
    )
      throw new DriveSharingError("invalid_argument");
    const timeZone = ownerTimeZone();
    const result = await this.request(
      token,
      null,
      guard,
      "",
      { ...draft, ...(timeZone ? { timeZone } : {}) },
      firebaseToken,
    );
    return {
      requestId: id(result.requestId),
      status: string(result.status, 80),
      revision: revision(result.revision),
    };
  }

  static async status(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingStatus> {
    const result = await this.request(token, requestId, guard);
    if (result.direction !== "incoming" && result.direction !== "outgoing")
      throw new DriveSharingError("invalid_response");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    const quotedAmountCents = result.quotedAmountCents === undefined
      ? undefined : optionalPrice(result.quotedAmountCents);
    if (quotedAmountCents === null)
      throw new DriveSharingError("invalid_response");
    const paymentRequired = optionalFlag(result.paymentRequired);
    const quoteVersion = result.quoteVersion === undefined ? undefined : (() => {
      if (!Number.isSafeInteger(result.quoteVersion) || (result.quoteVersion as number) < 0)
        throw new DriveSharingError("invalid_response");
      return result.quoteVersion as number;
    })();
    const requestedAccessDays = result.requestedAccessDays == null ? null : bulkCount(result.requestedAccessDays, 90);
    const approvedAccessDays = result.approvedAccessDays == null ? null : bulkCount(result.approvedAccessDays, 90);
    const accessExpiresAt = result.accessExpiresAt == null ? null : date(result.accessExpiresAt);
    if (requestedAccessDays === 0 || approvedAccessDays === 0 ||
      approvedAccessDays !== null && (requestedAccessDays === null || approvedAccessDays > requestedAccessDays))
      throw new DriveSharingError("invalid_response");
    const view: SharingStatus = {
      requestId,
      revision: revision(result.revision),
      status: string(result.status, 80),
      direction: result.direction,
      ...(typeof result.oneCopyRequested === "boolean" ? { oneCopyRequested: result.oneCopyRequested } : {}),
      ...(result.delivery && typeof result.delivery === "object" && ["one", "both"].includes((result.delivery as Record<string, unknown>).receiveThrough as string) ? { hostedDelivery: true as const } : {}),
      ...(typeof result.outcomeReason === "string" && ["no_matching_files", "matching_files_unshareable"].includes(result.outcomeReason)
        ? { outcomeReason: result.outcomeReason as SharingStatus["outcomeReason"] } : {}),
      ...(result.direction === "incoming" && result.outcomeReason === "matching_files_unshareable" &&
        Number.isSafeInteger(result.matchedFileCount) && (result.matchedFileCount as number) > 0 &&
        (result.matchedFileCount as number) <= 10000 && result.unshareableFileCount === result.matchedFileCount
        ? { matchedFileCount: result.matchedFileCount as number,
            unshareableFileCount: result.unshareableFileCount as number } : {}),
      ...(result.requestedAccessDays === undefined ? {} : { requestedAccessDays }),
      ...(result.approvedAccessDays === undefined ? {} : { approvedAccessDays }),
      ...(result.accessExpiresAt === undefined ? {} : { accessExpiresAt }),
      ...(quotedAmountCents === undefined ? {} : { quotedAmountCents }),
      ...(paymentRequired === undefined ? {} : { paymentRequired }),
      ...(quoteVersion === undefined ? {} : { quoteVersion }),
      // Additive requester views. A malformed view is dropped (fails closed:
      // no Pay, no refund claim) instead of hiding the whole request.
      ...(result.direction === "outgoing" && result.payment !== undefined
        ? { payment: parseRequesterPaymentView(result.payment) }
        : {}),
      ...(result.direction === "outgoing" && result.price !== undefined
        ? { price: parseRequesterPriceView(result.price) }
        : {}),
      ...parseRequestSetup(result),
      ...parseRequestQueue(result),
    };
    observeDriveRequestState(`${SHARING_PATH}/requests/${requestId}`, view, guard);
    return view;
  }

  static async lookupClient(
    token: string,
    clientRequestId: string,
    guard: SharingSessionGuard,
  ): Promise<string | null> {
    id(clientRequestId);
    const result = await this.request(
      token, null, guard, `/by-client/${clientRequestId}`,
    );
    return result.status === "draft" ? null : id(result.requestId);
  }

  static async requesterContext(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingRequestContext> {
    const result = await this.request(token, requestId, guard, "/context");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    const raw = record(result.purpose);
    const purpose = {
      purpose: string(raw.purpose, 2000),
      periodStart: raw.periodStart == null ? null : string(raw.periodStart, 10),
      periodEnd: raw.periodEnd == null ? null : string(raw.periodEnd, 10),
    };
    if (!purpose.purpose.trim() || !validDocumentRequestPeriod(purpose.periodStart, purpose.periodEnd))
      throw new DriveSharingError("invalid_response");
    const packageDisclosure = result.packageDisclosure == null ? null : parseDrivePackageDisclosure(result.packageDisclosure);
    if (result.packageDisclosure != null && !packageDisclosure) throw new DriveSharingError("invalid_response");
    if (result.requestRevision !== undefined && (!Number.isSafeInteger(result.requestRevision) || Number(result.requestRevision) < 1))
      throw new DriveSharingError("invalid_response");
    // Newer servers add the sealed Google account and when it was sent.
    const recipientEmail = result.recipientEmail == null ? null : string(result.recipientEmail, 320);
    if (recipientEmail !== null && !/^[^\s@]{1,64}@[^\s@]{1,254}$/.test(recipientEmail))
      throw new DriveSharingError("invalid_response");
    return {
      requestId,
      ...(result.packageDisclosure === undefined ? {} : { packageDisclosure }),
      ...(result.requestRevision === undefined ? {} : { requestRevision: Number(result.requestRevision) }),
      purpose,
      ...(result.recipientEmail === undefined ? {} : { recipientEmail }),
      ...(result.requestedAt === undefined
        ? {}
        : { requestedAt: result.requestedAt === null ? null : date(result.requestedAt) }),
      ...(result.timeZone === undefined
        ? {}
        : { timeZone: result.timeZone === null ? null : string(result.timeZone, 64) }),
    };
  }

  static async listRules(token: string, guard: SharingSessionGuard): Promise<TrustedDocumentRule[]> {
    guard();
    const response = await ApiService.apiFetch("/api/connectors/google_drive/sharing/rules", {
      method: "GET", cache: "no-store", headers: ApiService.getAuthHeaders(token),
      isEffectCurrent: () => { guard(); return true; },
    });
    guard();
    if (!response.ok) throw new DriveSharingError("request_failed", response.status);
    const payload = record(await response.json());
    guard();
    if (!Array.isArray(payload.items) || payload.items.length > 50)
      throw new DriveSharingError("invalid_response");
    return payload.items.map((value) => { const item = record(value);
      const scope = item.scope ?? "exact_files_same_request_purpose";
      const readiness = item.readiness ?? "reconnect_required";
      if (scope !== "exact_files_same_request_purpose" && scope !== "any_requested_drive_file" ||
          readiness !== "ready" && readiness !== "background_off" && readiness !== "reconnect_required")
        throw new DriveSharingError("invalid_response");
      return ({
      scope, readiness,
      ruleId: id(item.ruleId),
      version: revision(item.version),
      recipientEmail: string(item.recipientEmail, 320),
      purpose: {
        purpose: string(record(item.purpose).purpose),
        periodStart: record(item.purpose).periodStart === null ? null : string(record(item.purpose).periodStart, 10),
        periodEnd: record(item.purpose).periodEnd === null ? null : string(record(item.purpose).periodEnd, 10),
      },
      fileNames: (Array.isArray(item.fileNames) ? item.fileNames : []).map((value) => string(value, 1024)),
      status: "Trusted for documents" as const,
    }); });
  }

  static async revokeRule(
    token: string, rule: TrustedDocumentRule, guard: SharingSessionGuard,
  ): Promise<void> {
    guard();
    const response = await ApiService.apiFetch(
      `/api/connectors/google_drive/sharing/rules/${id(rule.ruleId)}/revoke`, {
        method: "POST", cache: "no-store",
        headers: {...ApiService.getAuthHeaders(token), "Content-Type": "application/json"},
        body: JSON.stringify({version: rule.version, confirmed: true}),
        isEffectCurrent: () => { guard(); return true; },
      },
    );
    guard();
    if (!response.ok) throw new DriveSharingError("rule_changed", response.status);
  }

  static async review(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingReview> {
    const raw = await this.request(token, requestId, guard, "/review");
    const result = raw.search === null && raw.bulkShare === null ? withoutEmptySearchProgress(raw) : raw;
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    const purpose = record(result.purpose);
    const selected = files(result.files, (file) => ({
      documentId: id(file.documentId),
      name: string(file.name, 1024),
    }));
    if (
      new Set(selected.map((file) => file.documentId)).size !== selected.length
    )
      throw new DriveSharingError("invalid_response");
    const coverage = result.coverage ? record(result.coverage) : null;
    if (
      coverage?.gaps != null &&
      (!Array.isArray(coverage.gaps) || coverage.gaps.length > 24)
    )
      throw new DriveSharingError("invalid_response");
    const expiresAt = result.expiresAt == null ? null : date(result.expiresAt);
    const reviewDigest =
      result.reviewDigest == null ? null : digest(result.reviewDigest);
    const hasDurableSearch = "search" in result || "bulkShare" in result;
    if (hasDurableSearch && (!("search" in result) || !("bulkShare" in result)))
      throw new DriveSharingError("invalid_response");
    if (result.durableAvailable === true && !hasDurableSearch)
      throw new DriveSharingError("invalid_response");
    const search = result.search == null ? null : parseDriveSearchStatus(result.search);
    const bulkShare = result.bulkShare == null ? null : parseBulkShareView(record(result.bulkShare));
    if (bulkShare && (!search || bulkShare.searchJobId !== search.jobId || bulkShare.recipientCount !== 1))
      throw new DriveSharingError("invalid_response");
    const batches = result.batches === undefined ? undefined : (() => {
      if (!Array.isArray(result.batches) || result.batches.length > 400 || !search)
        throw new DriveSharingError("invalid_response");
      const parsed = result.batches.map(item => parseBulkShareView(record(item)));
      if (parsed.some(batch => batch.searchJobId !== search.jobId || batch.recipientCount !== 1 ||
        result.progressiveAllowed === true && batch.fileCount > 25) ||
        new Set(parsed.map(batch => batch.shareId)).size !== parsed.length)
        throw new DriveSharingError("invalid_response");
      return parsed;
    })();
    const batchCount = result.batchCount === undefined ? undefined : bulkCount(result.batchCount, 400);
    if (batches && batchCount !== undefined && batchCount < batches.length)
      throw new DriveSharingError("invalid_response");
    const claimedPositions = result.claimedPositions === undefined ? undefined : (() => {
      if (!Array.isArray(result.claimedPositions) || result.claimedPositions.length > 10_000)
        throw new DriveSharingError("invalid_response");
      const parsed = result.claimedPositions.map(position => bulkCount(position, 10_000));
      if (parsed.includes(0) || new Set(parsed).size !== parsed.length ||
        parsed.some(position => !search || position > search.matched))
        throw new DriveSharingError("invalid_response");
      return parsed;
    })();
    const recoverablePositions = result.recoverablePositions === undefined ? undefined : (() => {
      if (!Array.isArray(result.recoverablePositions) || result.recoverablePositions.length > 10_000 ||
        !search || !claimedPositions)
        throw new DriveSharingError("invalid_response");
      const parsed = result.recoverablePositions.map(position => bulkCount(position, 10_000));
      if (parsed.includes(0) || new Set(parsed).size !== parsed.length ||
        parsed.some(position => position > search.matched || !claimedPositions.includes(position)))
        throw new DriveSharingError("invalid_response");
      return parsed;
    })();
    if (result.progressiveAllowed === true && batches && claimedPositions === undefined)
      throw new DriveSharingError("invalid_response");
    if (result.progressiveAllowed !== undefined && typeof result.progressiveAllowed !== "boolean")
      throw new DriveSharingError("invalid_response");
    if (result.progressiveAllowed === true && (!batches || !search || claimedPositions === undefined))
      throw new DriveSharingError("invalid_response");
    if (result.progressiveAllowed === true &&
      (batches?.some(batch => !batch.positions ||
        batch.positions.some(position => !claimedPositions?.includes(position))) ||
        bulkShare && (!bulkShare.positions ||
          bulkShare.positions.some(position => !claimedPositions?.includes(position)))))
      throw new DriveSharingError("invalid_response");
    const aggregateCounts = result.aggregateCounts === undefined ? undefined : (() => {
      const total = bulkCount(record(result.aggregateCounts).total, 10_000);
      return parseBulkCounts(result.aggregateCounts, total);
    })();
    if (result.durableAvailable !== undefined && typeof result.durableAvailable !== "boolean")
      throw new DriveSharingError("invalid_response");
    if (result.trustedAuto !== undefined && typeof result.trustedAuto !== "boolean")
      throw new DriveSharingError("invalid_response");
    if (result.v1LiveRequest !== undefined && typeof result.v1LiveRequest !== "boolean")
      throw new DriveSharingError("invalid_response");
    if (result.v1ManualReview !== undefined && result.v1ManualReview !== true)
      throw new DriveSharingError("invalid_response");
    const verifiedCount = result.v1ManualReview === true
      ? bulkCount(result.verifiedCount, 120)
      : undefined;
    const requestedAccessDays = result.requestedAccessDays == null ? null : bulkCount(result.requestedAccessDays, 90);
    const approvedAccessDays = result.approvedAccessDays == null ? null : bulkCount(result.approvedAccessDays, 90);
    const accessExpiresAt = result.accessExpiresAt == null ? null : date(result.accessExpiresAt);
    if (requestedAccessDays === 0 || approvedAccessDays === 0 ||
      approvedAccessDays !== null && (requestedAccessDays === null || approvedAccessDays > requestedAccessDays))
      throw new DriveSharingError("invalid_response");
    const requesterProfile = result.requesterProfile === undefined ? undefined : (() => {
      const profile = record(result.requesterProfile);
      if (profile.type !== "ria") throw new DriveSharingError("invalid_response");
      const optionalText = (value: unknown) => value == null ? null : string(value, 200);
      return { type: "ria" as const, displayName: optionalText(profile.displayName),
        legalName: optionalText(profile.legalName), crd: optionalText(profile.crd),
        firmName: optionalText(profile.firmName) };
    })();
    const reason = result.reason === undefined ? undefined : result.reason === ""
      ? "" : string(result.reason, 500);
    if (result.v1ManualReview === true &&
      (verifiedCount === 0 || result.agentPackage !== undefined || result.trustedAuto === true))
      throw new DriveSharingError("invalid_response");
    const ownerAllowed = optionalFlag(result.ownerAllowed);
    const allowAvailable = optionalFlag(result.allowAvailable);
    const priceOnlyAvailable = optionalFlag(result.priceOnlyAvailable);
    const paymentRequired = optionalFlag(result.paymentRequired);
    const priceCents = optionalPrice(result.priceCents);
    const ownerPayout = result.ownerPayout == null
      ? null
      : parseOwnerPayout(result.ownerPayout, requestId);
    const view: SharingReview = {
      ...(result.agentPackage === undefined ? {} : { agentPackage: parseAgentDocumentPackage(result.agentPackage) }),
      revision: revision(result.revision),
      status: string(result.status, 80),
      recipientEmail: string(result.recipientEmail, 320),
      ...(typeof result.oneCopyRequested === "boolean" ? { oneCopyRequested: result.oneCopyRequested } : {}),
      purpose: {
        purpose: string(purpose.purpose),
        periodStart:
          purpose.periodStart == null ? null : string(purpose.periodStart, 10),
        periodEnd:
          purpose.periodEnd == null ? null : string(purpose.periodEnd, 10),
      },
      files: selected,
      coverage: coverage
        ? {
            summary: string(coverage.coverage_summary ?? coverage.summary),
            status: string(coverage.coverage_status ?? "unknown", 30),
            gaps: ((coverage.gaps ?? []) as unknown[]).map((gap) =>
              string(gap),
            ),
            truncated: coverage.truncated === true,
          }
        : null,
      expiresAt,
      reviewDigest,
      canApprove:
        result.canApprove === true &&
        result.status === "review_ready" &&
        selected.length > 0 &&
        !!expiresAt &&
        !!reviewDigest,
      canTrustFutureRequests: result.canTrustFutureRequests === true,
      preparationError: preparationError(result.preparationError),
      ...(result.trustedAuto === true ? { trustedAuto: true } : {}),
      ...(result.v1LiveRequest === true ? { v1LiveRequest: true } : {}),
      ...(result.v1ManualReview === true ? { v1ManualReview: true, verifiedCount } : {}),
      ...(requesterProfile === undefined ? {} : { requesterProfile }),
      ...(reason === undefined ? {} : { reason }),
      ...(result.requestedAccessDays === undefined ? {} : { requestedAccessDays }),
      ...(result.approvedAccessDays === undefined ? {} : { approvedAccessDays }),
      ...(result.accessExpiresAt === undefined ? {} : { accessExpiresAt }),
      ...(result.durableAvailable === true ? { durableAvailable: true } : {}),
      ...(hasDurableSearch ? { search, bulkShare } : {}),
      ...(batches === undefined ? {} : { batches }),
      ...(batchCount === undefined ? {} : { batchCount }),
      ...(claimedPositions === undefined ? {} : { claimedPositions }),
      ...(recoverablePositions === undefined ? {} : { recoverablePositions }),
      ...(result.progressiveAllowed === true ? { progressiveAllowed: true } : {}),
      ...(aggregateCounts === undefined ? {} : { aggregateCounts }),
      ...(ownerAllowed === undefined ? {} : { ownerAllowed }),
      // Only a pending request not yet allowed can be decided.
      ...(priceOnlyAvailable === undefined ? {} : {
        priceOnlyAvailable: priceOnlyAvailable && result.status === "pending" && ownerAllowed !== true,
      }),
      ...(allowAvailable === undefined ? {} : {
        allowAvailable: allowAvailable && result.status === "pending" && ownerAllowed !== true,
      }),
      ...(paymentRequired === undefined ? {} : { paymentRequired }),
      ...(priceCents === undefined ? {} : { priceCents }),
      // Display only: a missing or malformed estimate never blocks the review.
      ...(isValidDocumentRequestPriceCents(result.estimateCents)
        ? { estimateCents: result.estimateCents }
        : {}),
      ...(result.ownerPayout === undefined ? {} : { ownerPayout }),
      ...(result.wholeDollarPrice === true ? { wholeDollarPrice: true } : {}),
      ...parseRequestSetup(result),
      ...parseRequestQueue(result),
    };
    observeDriveRequestState(`${SHARING_PATH}/requests/${requestId}/review`, view, guard);
    return view;
  }

  /** Start or recover the durable search bound to this incoming request. */
  static async startRequestSearch(
    token: string, requestId: string, guard: SharingSessionGuard,
  ): Promise<DriveSearchStatus> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return parseDriveSearchStatus(await this.request(token, requestId, guard, "/search",
      typeof timeZone === "string" && timeZone ? { timeZone } : {}));
  }

  /** Private frozen queries and date policy, through the existing owner GET. */
  static async requestSearchStatus(token: string, requestId: string, guard: SharingSessionGuard): Promise<DriveSearchStatus | null> {
    id(requestId);
    const result = await this.send(`${SHARING_PATH}/requests/${requestId}/search`, token, guard, undefined, undefined, VIEW_MAX_LENGTH, true);
    return result == null ? null : parseDriveSearchStatus(result);
  }

  /** A small page from the request-bound search, never the whole Drive set. */
  static async requestSearchFiles(
    token: string, requestId: string, jobId: string, guard: SharingSessionGuard,
    cursor: string | null = null,
  ): Promise<DriveSearchResults> {
    const suffix = cursor == null ? "" : `?cursor=${encodeURIComponent(bulkText(cursor, 1024))}`;
    return parseDriveSearchResults(await this.request(token, requestId, guard, `/search/files${suffix}`), jobId);
  }

  /** Freeze the owner's selected subset before the separate Share decision. */
  static async prepareRequestBulk(
    token: string, requestId: string, search: DriveSearchStatus,
    excludedPositions: number[], guard: SharingSessionGuard,
  ): Promise<DriveBulkShareView> {
    if (!isDriveSearchSelectionReady(search) ||
      search.matched - (search.unshareableCount ?? 0) <= 0 ||
      excludedPositions.length >= search.matched ||
      new Set(excludedPositions).size !== excludedPositions.length ||
      excludedPositions.some(position => !Number.isSafeInteger(position) || position < 1 || position > search.matched))
      throw new DriveSharingError("invalid_selection");
    const result = parseBulkShareView(await this.request(token, requestId, guard, "/bulk", {
      excludedPositions: [...excludedPositions].sort((a, b) => a - b),
    }));
    if (result.searchJobId !== search.jobId || result.fileCount <= 0 ||
      result.fileCount > search.matched - excludedPositions.length ||
      result.recipientCount !== 1)
      throw new DriveSharingError("invalid_response");
    return result;
  }

  /** Freeze only the owner's visible, committed search positions. Search may still be running. */
  static async prepareRequestBatch(
    token: string, requestId: string, search: DriveSearchStatus,
    positions: number[], guard: SharingSessionGuard,
  ): Promise<DriveBulkShareView> {
    if (!["running", "completed"].includes(search.status) || search.incompleteSearch ||
      search.coverage?.shareabilityVerified !== true ||
      positions.length < 1 || positions.length > 25 ||
      new Set(positions).size !== positions.length ||
      positions.some(position => !Number.isSafeInteger(position) || position < 1 || position > search.matched))
      throw new DriveSharingError("invalid_selection");
    const selected = [...positions].sort((a, b) => a - b);
    const result = parseBulkShareView(await this.request(token, requestId, guard, "/bulk", { positions: selected }));
    if (result.searchJobId !== search.jobId || result.fileCount !== selected.length ||
      result.recipientCount !== 1 || !result.positions ||
      result.positions.length !== selected.length ||
      result.positions.some((position, index) => position !== selected[index]))
      throw new DriveSharingError("invalid_response");
    return result;
  }

  static async delivery(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingDelivery> {
    const result = await this.request(token, requestId, guard, "/delivery");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    const fileCount = result.bulkShareId == null ? null : bulkCount(result.fileCount, 10_000);
    const sharedCount = fileCount === null ? null : bulkCount(result.sharedCount, fileCount);
    const counts = result.counts === undefined || fileCount === null ? undefined : parseBulkCounts(result.counts, fileCount);
    if (counts && counts.shared + counts.alreadyShared !== sharedCount)
      throw new DriveSharingError("invalid_response");
    const view: SharingDelivery = {
      status: string(result.status, 80),
      ...(result.noChargeReason === "existing_access" ? { noChargeReason: "existing_access" as const } : {}),
      ...(result.accessStopStatus == null ? {} : {
        accessStopStatus: accessStopStatus(result.accessStopStatus),
      }),
      ...(result.canStopAccess === undefined ? {} : {
        canStopAccess: canStopAccess(result.canStopAccess),
      }),
      files: files(result.files, parseDeliveryFile),
      ...(result.bulkShareId == null ? {} : {
        bulkShareId: id(result.bulkShareId),
        fileCount: fileCount!, sharedCount: sharedCount!,
        ...((result.bulkStatus ?? result.sharingStatus) == null ? {} : { bulkStatus: bulkStatus(result.bulkStatus ?? result.sharingStatus) }),
        ...(counts === undefined ? {} : { counts }),
        ...(result.issues === undefined ? {} : { issues: exactIssues(result, fileCount!) }),
      }),
      // Additive views. A malformed one is dropped (no action, no refund claim)
      // instead of hiding the delivery itself.
      ...(result.price === undefined ? {} : { price: parseRequesterPriceView(result.price) }),
      ...(result.recovery === undefined
        ? {}
        : { recovery: parseRequesterRecovery(result.recovery) }),
      ...(result.reviewRequest === undefined
        ? {}
        : { reviewRequest: parseOwnerReviewRequest(result.reviewRequest) }),
    };
    observeDriveRequestState(`${SHARING_PATH}/requests/${requestId}/delivery`, view, guard);
    return view;
  }

  static async deliveryFiles(
    token: string, requestId: string, guard: SharingSessionGuard,
    cursor: string | null = null,
  ): Promise<SharingDeliveryFilePage> {
    const suffix = cursor == null ? "" : `?cursor=${encodeURIComponent(bulkText(cursor, 1024))}`;
    const result = await this.request(token, requestId, guard, `/delivery/files${suffix}`);
    if (id(result.requestId) !== requestId) throw new DriveSharingError("invalid_response");
    return {
      files: files(result.files, parseDeliveryFile),
      nextCursor: result.nextCursor == null ? null : bulkText(result.nextCursor, 1024),
    };
  }

  static prepare(token: string, requestId: string, guard: SharingSessionGuard) {
    return this.request(token, requestId, guard, "/prepare", {});
  }

  /**
   * The same preparation as `prepare`, reporting public stages as they happen.
   * Throws `StreamUnavailable` when the route can't stream here, so the caller
   * falls back to `prepare` exactly once.
   */
  static async prepareStream(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
    {
      onStage,
      signal,
    }: {
      onStage: (stage: PrepareStage) => void;
      signal?: AbortSignal;
    },
  ): Promise<PrepareOutcome> {
    id(requestId);
    guard();
    let response: Response;
    try {
      response = await nativeStreamFetch(
        `${SHARING_PATH}/requests/${requestId}/prepare/stream`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            ...ApiService.getAuthHeaders(token),
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: "{}",
          signal,
        },
      );
    } catch (error) {
      if (unimplemented(error)) throw new StreamUnavailable();
      throw error;
    }
    guard();
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      guard();
      let detail: unknown;
      try {
        detail = record(JSON.parse(text)).detail;
      } catch {
        detail = undefined;
      }
      const code =
        detail && typeof detail === "object" && !Array.isArray(detail)
          ? (detail as RecordValue).code
          : undefined;
      const known =
        typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : null;
      // FastAPI's own Not Found: a backend older than this web build.
      if (!known && (response.status === 404 || response.status === 405))
        throw new StreamUnavailable();
      // The stream route is at capacity; the plain POST still serves the owner.
      if (known === "sharing_unavailable" && response.status === 503)
        throw new StreamUnavailable();
      throw new DriveSharingError(known ?? "request_failed", response.status);
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new StreamUnavailable();
    }
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal?.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder();
    let remainder = "";
    let received = 0;
    let reached = -1;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          guard();
          return "interrupted";
        }
        guard();
        if (chunk.done) return "interrupted";
        received += chunk.value.byteLength;
        if (received > VIEW_MAX_LENGTH)
          throw new DriveSharingError("invalid_response");
        const parsed = parseSSEBlocks(
          decoder.decode(chunk.value, { stream: true }),
          remainder,
        );
        remainder = parsed.remainder;
        if (remainder.length > STREAM_FRAME_MAX_LENGTH)
          throw new DriveSharingError("invalid_response");
        for (const frame of parsed.events) {
          if (frame.data.length > STREAM_FRAME_MAX_LENGTH)
            throw new DriveSharingError("invalid_response");
          let payload: RecordValue;
          try {
            payload = record(JSON.parse(frame.data));
          } catch {
            throw new DriveSharingError("invalid_response");
          }
          if (payload.event !== frame.event)
            throw new DriveSharingError("invalid_response");
          if (frame.event === "stage") {
            const index = PREPARE_STAGES.indexOf(payload.stage as PrepareStage);
            if (index < 0) throw new DriveSharingError("invalid_response");
            // Stages only move forward; a repeat or regression is dropped.
            if (index > reached) {
              reached = index;
              onStage(payload.stage as PrepareStage);
            }
          } else if (frame.event === "complete") {
            if (typeof payload.status !== "string" || !PREPARE_RESULTS.has(payload.status))
              throw new DriveSharingError("invalid_response");
            return payload.status as PrepareOutcome;
          } else if (frame.event === "error") {
            if (typeof payload.code !== "string" || !STREAM_ERROR_CODES.has(payload.code))
              throw new DriveSharingError("invalid_response");
            // Never render the server message.
            throw new DriveSharingError(payload.code);
          }
          // Heartbeats and unknown events are ignored.
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  }

  static approve(
    token: string,
    requestId: string,
    review: SharingReview,
    guard: SharingSessionGuard,
    // Required: a caller that forgets the selection must not share the whole review.
    documentIds: string[],
    trustFutureRequests = false,
    trustScope?: "any_requested_drive_file",
  ) {
    if (
      !review.canApprove ||
      !review.expiresAt ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw new DriveSharingError("review_changed");
    // Only a non-empty selection of the files A reviewed can be shared.
    const reviewed = new Set(review.files.map((file) => file.documentId));
    if (
      documentIds.length === 0 ||
      new Set(documentIds).size !== documentIds.length ||
      documentIds.some((id) => !reviewed.has(id))
    )
      throw new DriveSharingError("invalid_selection");
    return this.request(token, requestId, guard, "/approve", {
      revision: review.revision,
      reviewDigest: review.reviewDigest,
      documentIds,
      confirmed: true,
      ...(trustFutureRequests ? {trustFutureRequests: true} : {}),
      ...(trustScope ? {trustScope, trustDisclosureVersion: "drive-any-requested-file-including-future-v1"} : {}),
    });
  }
  /**
   * Decline, withdraw (cancel) or refresh at a revision. A withdrawal's reply
   * carries the payment view: closed, or refund pending when payment won the
   * race. A paid or already shared request is refused with `request_paid`.
   */
  static async decide(
    token: string,
    requestId: string,
    action: "decline" | "cancel" | "review/refresh",
    value: number,
    guard: SharingSessionGuard,
  ): Promise<SharingDecision> {
    const result = await this.request(token, requestId, guard, `/${action}`, {
      revision: value,
    });
    if (action !== "cancel" || result.payment === undefined) return result;
    return { ...result, payment: parseRequesterPaymentView(result.payment) };
  }
  /**
   * Approve the prepared package by revision and digest. Legacy requests omit
   * those fields; the server rejects omissions for package-marked requests.
   */
  static async allow(
    token: string,
    requestId: string,
    input: SharingAllowInput,
    guard: SharingSessionGuard,
  ): Promise<SharingAllowResult> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
      input.amountCents !== null && !isValidDocumentRequestPriceCents(input.amountCents))
      throw new DriveSharingError("invalid_argument");
    const hasPackage = input.packageRevision !== undefined || input.packageDigest !== undefined;
    if (hasPackage && (!Number.isSafeInteger(input.packageRevision) || input.packageRevision! < 0 ||
        typeof input.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.packageDigest)))
      throw new DriveSharingError("invalid_argument");
    const result = await this.request(token, requestId, guard, "/allow", {
      revision: input.revision,
      ...(hasPackage ? { packageRevision: input.packageRevision, packageDigest: input.packageDigest } : {}),
      ...(input.amountCents === null ? {} : { amountCents: input.amountCents }),
      confirmed: true,
      ...(input.oneCopyAccepted === true ? { oneCopyAccepted: true } : {}),
    });
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      requestId,
      status: string(result.status, 80),
      revision: revision(result.revision),
    };
  }
  /** Price a trusted request without granting independent owner-allowed authority. */
  static async setRequestPrice(
    token: string, requestId: string, input: SharingAllowInput, guard: SharingSessionGuard,
  ): Promise<SharingAllowResult> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
        !isValidDocumentRequestPriceCents(input.amountCents))
      throw new DriveSharingError("invalid_argument");
    const result = await this.request(token, requestId, guard, "/price", {
      revision: input.revision, amountCents: input.amountCents, confirmed: true,
    });
    if (id(result.requestId) !== requestId) throw new DriveSharingError("invalid_response");
    return { requestId, status: string(result.status, 80), revision: revision(result.revision) };
  }

  static async prepareRevocation(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingRevocationReview> {
    const result = await this.request(
      token,
      requestId,
      guard,
      "/revocation/prepare",
      {},
    );
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      revision: revision(result.revision),
      directiveId: string(result.directiveId, 200),
      reviewDigest: digest(result.reviewDigest),
      expiresAt: date(result.expiresAt),
      files: files(result.files, (file) => ({
        grantId: id(file.grantId),
        name: string(file.name, 1024),
        recipientEmail: string(file.recipientEmail, 320),
      })),
      ...(result.affectedCount == null ? {} : { affectedCount: bulkCount(result.affectedCount, 10_000) }),
      ...(result.pendingCount == null ? {} : { pendingCount: bulkCount(result.pendingCount, 10_000) }),
    };
  }
  static revoke(
    token: string,
    requestId: string,
    review: SharingRevocationReview,
    guard: SharingSessionGuard,
  ) {
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new DriveSharingError("review_changed");
    return this.request(token, requestId, guard, "/revocation/confirm", {
      revision: review.revision,
      directiveId: review.directiveId,
      reviewDigest: review.reviewDigest,
      grantIds: review.files.map((file) => file.grantId),
      confirmed: true,
    });
  }

  /**
   * Creates a pending question only. Nothing reads the owner's Drive until
   * the owner allows it, so the asker needs no Google identity here.
   */
  static async createQuery(
    token: string,
    draft: DriveQueryDraft,
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    const owner =
      typeof draft.ownerPersonRef === "string" &&
      draft.ownerUserId === undefined
        ? DOCUMENT_REQUEST_UUID.test(draft.ownerPersonRef)
          ? { ownerPersonRef: draft.ownerPersonRef }
          : null
        : typeof draft.ownerUserId === "string" &&
            draft.ownerPersonRef === undefined &&
            /^[A-Za-z0-9_-]{1,128}$/.test(draft.ownerUserId)
          ? { ownerUserId: draft.ownerUserId }
          : null;
    if (
      !owner ||
      !DOCUMENT_REQUEST_UUID.test(draft.clientRequestId) ||
      !validDriveQuery(draft.query)
    )
      throw new DriveSharingError("invalid_argument");
    const view = parseDriveQueryView(
      await this.send(`${SHARING_PATH}/queries`, token, guard, {
        ...owner,
        clientRequestId: draft.clientRequestId,
        query: draft.query,
      }),
    );
    if (view.direction !== "outgoing")
      throw new DriveSharingError("invalid_response");
    return view;
  }

  static async listQueries(
    token: string,
    direction: "incoming" | "outgoing",
    guard: SharingSessionGuard,
    page: { limit?: number; offset?: number } = {},
  ): Promise<DriveQueryPage> {
    const { limit = 20, offset = 0 } = page;
    if (
      (direction !== "incoming" && direction !== "outgoing") ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > QUERY_PAGE_MAX ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new DriveSharingError("invalid_argument");
    const result = await this.send(
      `${SHARING_PATH}/queries?${new URLSearchParams({
        direction,
        limit: String(limit),
        offset: String(offset),
      })}`,
      token,
      guard,
      undefined,
      undefined,
      limit * VIEW_MAX_LENGTH,
    );
    if (!Array.isArray(result.items) || result.items.length > limit)
      throw new DriveSharingError("invalid_response");
    const items = result.items.map(parseDriveQueryView);
    if (items.some((item) => item.direction !== direction))
      throw new DriveSharingError("invalid_response");
    return { items, hasMore: result.hasMore === true };
  }

  static async getQuery(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    return this.queryView(token, requestId, guard, "");
  }

  /** Runs one bounded search of the owner's Drive; can take ~160 seconds. */
  static allowQuery(
    token: string,
    requestId: string,
    revisionValue: number,
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    const timeZone = ownerTimeZone();
    return this.queryView(token, requestId, guard, "/allow", {
      revision: revisionValue,
      ...(timeZone ? { timeZone } : {}),
    });
  }

  static denyQuery(
    token: string,
    requestId: string,
    revisionValue: number,
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    return this.queryView(token, requestId, guard, "/deny", {
      revision: revisionValue,
    });
  }

  /** The asker withdraws their own question; never reads Drive. */
  static cancelQuery(
    token: string,
    requestId: string,
    revisionValue: number,
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    return this.queryView(token, requestId, guard, "/cancel", {
      revision: revisionValue,
    });
  }

  /** The owner searches their own Drive to share with one connected person. */
  static async prepareOwnerShare(
    token: string,
    draft: {
      recipientPersonRef: string;
      clientRequestId: string;
      query: string;
      timeZone?: string;
    },
    guard: SharingSessionGuard,
  ): Promise<DriveOwnerShareView> {
    if (
      !DOCUMENT_REQUEST_UUID.test(draft.recipientPersonRef) ||
      !DOCUMENT_REQUEST_UUID.test(draft.clientRequestId) ||
      !validDriveQuery(draft.query)
    )
      throw new DriveSharingError("invalid_argument");
    return parseOwnerShareView(
      await this.send(`${SHARING_PATH}/owner-shares`, token, guard, {
        recipientPersonRef: draft.recipientPersonRef,
        clientRequestId: draft.clientRequestId,
        query: draft.query,
        ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
      }),
    );
  }

  /** The owner searches their own Drive to share with their Trusted circle. */
  static async prepareTrustedShare(
    token: string,
    draft: { clientRequestId: string; query: string; timeZone?: string },
    guard: SharingSessionGuard,
  ): Promise<DriveCircleShareView> {
    if (!DOCUMENT_REQUEST_UUID.test(draft.clientRequestId) || !validDriveQuery(draft.query))
      throw new DriveSharingError("invalid_argument");
    return parseCircleShareView(
      await this.send(`${SHARING_PATH}/owner-shares`, token, guard, {
        audience: "trusted_circle",
        clientRequestId: draft.clientRequestId,
        query: draft.query,
        ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
      }),
    );
  }

  /** The owner shares chosen files from their own search, as Viewer. */
  static async shareOwnerFiles(
    token: string,
    requestId: string,
    fileRefs: string[],
    guard: SharingSessionGuard,
  ): Promise<DriveOwnerShareView> {
    if (
      !DOCUMENT_REQUEST_UUID.test(requestId) ||
      fileRefs.length === 0 ||
      fileRefs.length > 8 ||
      new Set(fileRefs).size !== fileRefs.length ||
      fileRefs.some((ref) => !QUERY_FILE_REF.test(ref))
    )
      throw new DriveSharingError("invalid_selection");
    return parseOwnerShareView(
      await this.send(
        `${SHARING_PATH}/owner-shares/${requestId}/share`,
        token,
        guard,
        { fileRefs },
      ),
    );
  }

  /** Create or recover the one reviewed bulk share bound to this saved search. */
  static async prepareBulkShare(token: string, searchJobId: string, guard: SharingSessionGuard,
    clientRequestId = searchJobId): Promise<DriveBulkShareView> {
    id(searchJobId); id(clientRequestId);
    return parseBulkShareView(await this.send(`${SHARING_PATH}/bulk`, token, guard,
      { searchJobId, clientRequestId, audience: "trusted_circle" }));
  }

  /** Discover prior bulk progress after reopening without starting a new share. */
  static async recentBulkShares(token: string, guard: SharingSessionGuard): Promise<DriveBulkShareView[]> {
    const value = await this.send(`${SHARING_PATH}/bulk`, token, guard);
    if (!Array.isArray(value.shares) || value.shares.length > 20) throw new DriveSharingError("invalid_response");
    const shares = value.shares.map(item => parseBulkShareView(record(item)));
    if (new Set(shares.map(item => item.shareId)).size !== shares.length)
      throw new DriveSharingError("invalid_response");
    return shares;
  }

  /** Discover prior bulk progress after reopening without starting a new share. */
  static async bulkSharesForSearch(token: string, searchJobId: string, guard: SharingSessionGuard): Promise<DriveBulkShareView[]> {
    id(searchJobId);
    const value = await this.send(`${SHARING_PATH}/bulk?searchJobId=${encodeURIComponent(searchJobId)}`, token, guard);
    if (!Array.isArray(value.shares) || value.shares.length > 20) throw new DriveSharingError("invalid_response");
    const shares = value.shares.map(item => parseBulkShareView(record(item)));
    if (shares.some(item => item.searchJobId !== searchJobId) ||
      new Set(shares.map(item => item.shareId)).size !== shares.length) throw new DriveSharingError("invalid_response");
    return shares;
  }

  static async bulkShareStatus(token: string, shareId: string, guard: SharingSessionGuard): Promise<DriveBulkShareView> {
    id(shareId);
    const view = parseBulkShareView(await this.send(`${SHARING_PATH}/bulk/${shareId}`, token, guard));
    if (view.shareId !== shareId) throw new DriveSharingError("invalid_response");
    return view;
  }

  static async bulkShareFiles(token: string, shareId: string, guard: SharingSessionGuard, cursor: string | null = null): Promise<DriveBulkShareFilePage> {
    id(shareId);
    const suffix = cursor == null ? "" : `?cursor=${encodeURIComponent(bulkText(cursor, 1024))}`;
    const page = parseBulkFilePage(await this.send(`${SHARING_PATH}/bulk/${shareId}/files${suffix}`, token, guard));
    if (page.shareId !== shareId) throw new DriveSharingError("invalid_response");
    return page;
  }

  static async approveBulkShare(token: string, view: DriveBulkShareView, guard: SharingSessionGuard,
    accessDays?: number): Promise<DriveBulkShareView> {
    if (view.status !== "review_ready" || !view.canApprove) throw new DriveSharingError("invalid_argument");
    if (accessDays !== undefined && (!Number.isSafeInteger(accessDays) || accessDays < 1 || accessDays > 90))
      throw new DriveSharingError("invalid_argument");
    const result = parseBulkShareView(await this.send(`${SHARING_PATH}/bulk/${id(view.shareId)}/approve`, token, guard,
      { revision: revision(view.revision), reviewDigest: digest(view.reviewDigest), confirmed: true,
        ...(accessDays === undefined ? {} : { accessDays }) }));
    if (result.shareId !== view.shareId || result.searchJobId !== view.searchJobId)
      throw new DriveSharingError("invalid_response");
    return result;
  }

  /** Retry only the exact reviewed effects the server declares safe to retry. */
  static async retryBulkShare(token: string, view: DriveBulkShareView, guard: SharingSessionGuard): Promise<DriveBulkShareView> {
    if (view.canRetry !== true || !view.retryableCount || !["partial", "failed"].includes(view.status))
      throw new DriveSharingError("invalid_argument");
    const result = parseBulkShareView(await this.send(`${SHARING_PATH}/bulk/${id(view.shareId)}/retry`, token, guard,
      { revision: revision(view.revision), reviewDigest: digest(view.reviewDigest), confirmed: true }));
    if (result.shareId !== view.shareId || result.searchJobId !== view.searchJobId || result.fileCount !== view.fileCount ||
      result.recipientCount !== view.recipientCount)
      throw new DriveSharingError("invalid_response");
    return result;
  }

  static async stopBulkShare(token: string, shareId: string, guard: SharingSessionGuard): Promise<DriveBulkShareView> {
    id(shareId);
    const result = parseBulkShareView(await this.send(`${SHARING_PATH}/bulk/${shareId}/stop`, token, guard, {}));
    if (result.shareId !== shareId) throw new DriveSharingError("invalid_response");
    return result;
  }

  /** A recipient sees only files whose Viewer grant was confirmed. No Drive connector is required. */
  static async receivedBulkShares(token: string, guard: SharingSessionGuard): Promise<ReceivedDriveBulkShare[]> {
    const value = await this.send(`${SHARING_PATH}/bulk/received`, token, guard);
    if (!Array.isArray(value.shares) || value.shares.length > 50) throw new DriveSharingError("invalid_response");
    const shares = value.shares.map(item => {
      const row = record(item);
      const status = bulkText(row.status, 20) as DriveBulkShareView["status"];
      if (!BULK_STATUSES.has(status)) throw new DriveSharingError("invalid_response");
      return { shareId: id(row.shareId), status, sharedCount: bulkCount(row.sharedCount, 100_000),
        createdAt: date(row.createdAt), updatedAt: date(row.updatedAt) };
    });
    if (new Set(shares.map(item => item.shareId)).size !== shares.length)
      throw new DriveSharingError("invalid_response");
    return shares;
  }

  static async receivedBulkFiles(token: string, shareId: string, guard: SharingSessionGuard,
    cursor: string | null = null): Promise<ReceivedDriveBulkFilesPage> {
    id(shareId);
    const suffix = cursor == null ? "" : `?cursor=${encodeURIComponent(bulkText(cursor, 1024))}`;
    const value = await this.send(`${SHARING_PATH}/bulk/received/${shareId}/files${suffix}`, token, guard);
    if (id(value.shareId) !== shareId || !Array.isArray(value.files) || value.files.length > 25)
      throw new DriveSharingError("invalid_response");
    const files = value.files.map(item => {
      const row = record(item);
      return { name: bulkText(row.name, 1000), openUrl: row.openUrl == null ? null : bulkFileUrl(row.openUrl),
        modifiedTime: row.modifiedTime == null ? null : date(row.modifiedTime) };
    });
    return { shareId, sharedCount: bulkCount(value.sharedCount, 100_000), files,
      nextCursor: value.nextCursor == null ? null : bulkText(value.nextCursor, 1024) };
  }

  /** The owner shares chosen files from an answered question, as Viewer. */
  static shareQueryFiles(
    token: string,
    requestId: string,
    fileRefs: string[],
    guard: SharingSessionGuard,
  ): Promise<DriveQueryView> {
    if (
      fileRefs.length === 0 ||
      fileRefs.length > 8 ||
      new Set(fileRefs).size !== fileRefs.length ||
      fileRefs.some((ref) => !QUERY_FILE_REF.test(ref))
    )
      throw new DriveSharingError("invalid_selection");
    return this.queryView(token, requestId, guard, "/share", { fileRefs });
  }

  private static async queryView(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
    action: "" | "/allow" | "/deny" | "/cancel" | "/share",
    body?: { revision: number; timeZone?: string } | { fileRefs: string[] },
  ): Promise<DriveQueryView> {
    if (
      !DOCUMENT_REQUEST_UUID.test(requestId) ||
      (body !== undefined &&
        "revision" in body &&
        (!Number.isSafeInteger(body.revision) || body.revision < 0))
    )
      throw new DriveSharingError("invalid_argument");
    const view = parseDriveQueryView(
      await this.send(
        `${SHARING_PATH}/queries/${requestId}${action}`,
        token,
        guard,
        body,
      ),
    );
    if (view.requestId.toLowerCase() !== requestId.toLowerCase())
      throw new DriveSharingError("invalid_response");
    return view;
  }
}

/** The owner's own calendar day decides dates like "24th September". */
function ownerTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone)
      ? zone
      : null;
  } catch {
    return null;
  }
}
