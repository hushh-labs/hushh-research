import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";

export type SharingStatus = {
  requestId: string;
  status: string;
  revision: number;
  direction: "incoming" | "outgoing";
};
export type DocumentRequestDraft = {
  ownerPersonRef: string;
  clientRequestId: string;
  purpose: {
    purpose: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
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
export type SharingReview = {
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
};
const SHARING_PREPARATION_ERRORS = [
  "no_relevant_files",
  "no_ready_files",
  "narrow_selection_required",
  "source_changed",
  "preparation_unavailable",
  "trust_revoked",
] as const;
/** Why preparation ended without suggestions. Unknown codes are dropped. */
export type SharingPreparationError =
  (typeof SHARING_PREPARATION_ERRORS)[number];
function preparationError(value: unknown): SharingPreparationError | null {
  return (SHARING_PREPARATION_ERRORS as readonly unknown[]).includes(value)
    ? (value as SharingPreparationError)
    : null;
}
export type SharingDelivery = {
  status: string;
  files: {
    name: string;
    status: string;
    revocationStatus: string | null;
    grantId: string | null;
    managed: boolean;
    openUrl: string | null;
    manageInGoogle: boolean;
  }[];
};
export type SharingRevocationReview = {
  revision: number;
  directiveId: string;
  reviewDigest: string;
  expiresAt: string;
  files: { grantId: string; name: string; recipientEmail: string }[];
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

export class DriveSharingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super("Could not complete the document request. Refresh and try again.");
  }
}
type RecordValue = Record<string, unknown>;
export type SharingSessionGuard = () => void;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DriveSharingError("invalid_response");
  return value as RecordValue;
}
function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || value.length > max)
    throw new DriveSharingError("invalid_response");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DriveSharingError("invalid_response");
  return value as number;
}
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
function digest(value: unknown): string {
  const result = string(value, 64);
  if (!/^[0-9a-f]{64}$/.test(result))
    throw new DriveSharingError("invalid_response");
  return result;
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
          files: queryFiles(rawAnswer.files, direction),
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
};

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
  | "limit";
const CIRCLE_EXCLUSIONS = new Set<DriveCircleExclusion>([
  "not_connected",
  "contacts",
  "circle",
  "imported",
  "unavailable",
  "no_google_account",
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
    };
  });
  const excluded = value.excluded.map((item) => {
    const row = record(item);
    const reason = string(row.reason, 32) as DriveCircleExclusion;
    if (!CIRCLE_EXCLUSIONS.has(reason)) throw new DriveSharingError("invalid_response");
    return { name: row.name == null ? null : string(row.name, 200), reason };
  });
  const files =
    status === "ready" || status === "shared" ? queryFiles(value.files, "incoming") : [];
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

  private static async send(
    path: string,
    token: string,
    guard: SharingSessionGuard,
    body?: object,
    firebaseToken?: string,
    maxLength = VIEW_MAX_LENGTH,
  ): Promise<RecordValue> {
    guard();
    const response = await ApiService.apiFetch(
      path,
      {
        isEffectCurrent: () => {
          guard();
          return true;
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
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    guard();
    const serialized = await response.text();
    guard();
    if (serialized.length > maxLength)
      throw new DriveSharingError("invalid_response");
    let payload: RecordValue;
    try {
      payload = record(JSON.parse(serialized));
    } catch {
      throw new DriveSharingError("invalid_response", response.status);
    }
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
      !draft.purpose.purpose.trim() ||
      draft.purpose.purpose.length > 2000 ||
      !validDocumentRequestPeriod(
        draft.purpose.periodStart,
        draft.purpose.periodEnd,
      )
    )
      throw new DriveSharingError("invalid_argument");
    const result = await this.request(
      token,
      null,
      guard,
      "",
      draft,
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
    return {
      requestId,
      revision: revision(result.revision),
      status: string(result.status, 80),
      direction: result.direction,
    };
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
    const result = await this.request(token, requestId, guard, "/review");
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
    return {
      revision: revision(result.revision),
      status: string(result.status, 80),
      recipientEmail: string(result.recipientEmail, 320),
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
    };
  }

  static async delivery(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingDelivery> {
    const result = await this.request(token, requestId, guard, "/delivery");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      status: string(result.status, 80),
      files: files(result.files, (file) => {
        const openUrl = file.openUrl == null ? null : string(file.openUrl, 512);
        if (
          openUrl &&
          !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(
            openUrl,
          )
        )
          throw new DriveSharingError("invalid_response");
        return {
          name: string(file.name, 1024),
          status: string(file.status, 80),
          revocationStatus:
            file.revocationStatus == null
              ? null
              : string(file.revocationStatus, 80),
          grantId: file.grantId == null ? null : id(file.grantId),
          managed: file.managed === true,
          openUrl,
          manageInGoogle: file.manageInGoogle === true,
        };
      }),
    };
  }

  static prepare(token: string, requestId: string, guard: SharingSessionGuard) {
    return this.request(token, requestId, guard, "/prepare", {});
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
  static decide(
    token: string,
    requestId: string,
    action: "decline" | "cancel" | "review/refresh",
    value: number,
    guard: SharingSessionGuard,
  ) {
    return this.request(token, requestId, guard, `/${action}`, {
      revision: value,
    });
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
