import { trackEvent } from "@/lib/observability/client";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import {
  buildGmailNudgesPath,
  buildGmailReceiptsPath,
  buildGmailStatusPath,
  buildGmailSyncRunPath,
  GMAIL_RECEIPTS_API_TEMPLATES,
} from "@/lib/services/kai-profile-api-paths";

const MAX_LIVE_RECEIPTS_PER_PAGE = 6;

// SHORT (1 min) TTL: fast enough to still reflect a just-completed OAuth
// connect (callers that need guaranteed-fresh data, like the OAuth return
// page, pass `force: true` to bypass this cache), but long enough that
// repeated mounts of the same screen (e.g. `/one/setup`) within a few
// seconds don't each trigger their own network round trip.
const gmailStatusCacheKey = (userId: string) =>
  `gmail_connection_status_${userId}`;

function trackGmailEventForOwner(
  userId: string,
  eventName: Parameters<typeof trackEvent>[0],
  payload: Parameters<typeof trackEvent>[1],
): void {
  if (AuthService.getCurrentUser()?.uid !== userId) return;
  trackEvent(eventName, payload as never);
}

export type GmailConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "connected_initial_scan_running"
  | "connected_backfill_running"
  | "needs_reauthentication"
  | "sync_failed"
  | "error";

export interface GmailSyncRun {
  run_id: string;
  user_id: string;
  trigger_source: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  sync_mode?:
    "bootstrap" | "incremental" | "manual" | "recovery" | "backfill" | null;
  start_history_id?: string | null;
  end_history_id?: string | null;
  requested_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  listed_count: number;
  filtered_count: number;
  synced_count: number;
  extracted_count: number;
  duplicates_dropped: number;
  extraction_success_rate: number;
  error_message?: string | null;
  metrics?: Record<string, unknown>;
}

export interface GmailConnectionStatus {
  configured: boolean;
  connected: boolean;
  status: "connected" | "disconnected" | "error";
  connection_state?:
    | "not_configured"
    | "not_connected"
    | "connected"
    | "needs_reauth"
    | "error"
    | null;
  sync_state?:
    | "idle"
    | "syncing"
    | "incremental_running"
    | "bootstrap_running"
    | "backfill_running"
    | "failed"
    | null;
  bootstrap_state?:
    "idle" | "queued" | "running" | "completed" | "failed" | null;
  watch_status?:
    | "unknown"
    | "active"
    | "expiring"
    | "expired"
    | "failed"
    | "not_configured"
    | null;
  watch_expires_at?: string | null;
  status_refreshed_at?: string | null;
  needs_reauth?: boolean | null;
  receipt_counts?: Record<string, number | null> | null;
  /** Legacy server receipt rows remain readable while new receipt writes are cut over. */
  receipt_storage_mode?: "legacy_read_only";
  receipt_sync_available?: boolean;
  receipt_storage_message?: string;
  google_email?: string | null;
  google_sub?: string | null;
  scope_csv: string;
  /** Provider-side draft creation is separate from local composition and sending. */
  compose_permission_granted?: boolean;
  modify_permission_granted?: boolean;
  /** Google granted the Gmail send provider scope during the shared connection. */
  send_permission_granted?: boolean;
  last_sync_at?: string | null;
  last_sync_status:
    "idle" | "queued" | "running" | "completed" | "failed" | "canceled";
  last_sync_error?: string | null;
  auto_sync_enabled: boolean;
  revoked: boolean;
  connected_at?: string | null;
  disconnected_at?: string | null;
  latest_run?: GmailSyncRun | null;
}

export interface GmailConnectStartResponse {
  configured: boolean;
  authorize_url: string;
  state: string;
  redirect_uri: string;
  expires_at: string;
}

export interface GmailNativeConnectStartResponse {
  configured: boolean;
  server_client_id: string;
  purpose: "read" | "send" | "compose";
}

export interface GmailSyncQueueResponse {
  accepted: boolean;
  reason?: string;
  run?: GmailSyncRun | null;
}

export interface ReceiptListItem {
  id: number;
  /** Stable, account-bound identity used for backend detail selection. */
  source_id?: string;
  receipt_key?: string;
  source_kind?: "gmail_live" | "gmail_device" | "legacy_read_only";
  sender_domain?: string | null;
  gmail_message_id: string;
  gmail_thread_id?: string | null;
  gmail_internal_date?: string | null;
  subject?: string | null;
  snippet?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  merchant_name?: string | null;
  status?: ReceiptLifecycleStatus | null;
  recurrence?: ReceiptRecurrence;
  attention_state?: ReceiptAttentionState;
  attention_reason?: ReceiptAttentionReason | null;
  attention_is_prediction?: boolean;
  attention_date?: string | null;
  identifier_kind?: "order" | "invoice" | "receipt" | "pnr" | null;
  identifier_value?: string | null;
  short_detail?: string | null;
  cleaned_preview?: string | null;
  transaction_date?: string | null;
  document_kind?: "invoice" | "receipt" | "payment_confirmation" | "order_confirmation" | "booking" | "fulfillment" | null;
  identifiers?: Array<{ kind: "order" | "invoice" | "receipt" | "pnr" | "payment"; value: string }>;
  /** Validated passages from the scan's single extraction, reused by detail. */
  source_evidence?: GmailReceiptSourceEvidence[];
  category?: ReceiptCategory | null;
  category_confidence?: number | null;
  merchant_domain?: string | null;
  order_id?: string | null;
  currency?: string | null;
  amount?: number | null;
  receipt_date?: string | null;
  preview?: string | null;
  classification_confidence?: number | null;
  classification_source?: "agent" | "deterministic" | "llm";
  event_type?:
    "purchase" | "fulfillment" | "refund" | "cancellation" | "unknown";
  created_at?: string;
  updated_at?: string;
}

export type ReceiptCategory =
  | "Shopping"
  | "Food"
  | "Travel"
  | "Transport"
  | "Software & Subscriptions"
  | "Cloud & Infra"
  | "Bills"
  | "Uncategorized"
  | "Subscription"
  | "Other";

export type ReceiptLifecycleStatus =
  | "paid"
  | "overdue"
  | "refunded"
  | "cancelled"
  | "trial"
  | "delivered"
  | "payment_failed"
  | "suspended"
  | "renewal_due";

export type ReceiptRecurrence = "recurring" | "one_time" | "unknown";
export type ReceiptAttentionState =
  | "none"
  | "needs_attention"
  | "coming_up"
  | "needs_review";
export type ReceiptAttentionReason =
  | "overdue"
  | "payment_failed"
  | "suspended"
  | "renewal_due"
  | "low_confidence";

export interface ReceiptListResponse {
  items: ReceiptListItem[];
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
}

export interface GmailLiveReceiptItem extends ReceiptListItem {
  source_id: string;
  receipt_key: string;
  source_kind: "gmail_live";
  gmail_thread_id: string | null;
  merchant_name: string | null;
  merchant_domain: string | null;
  sender_domain: string | null;
  from_name: string | null;
  from_email: string | null;
  order_id: string | null;
  amount: number | null;
  currency: string | null;
  receipt_date: string | null;
  gmail_internal_date: string | null;
  subject: string | null;
  preview: string | null;
  snippet: string | null;
  classification_confidence: number;
  classification_source: "agent";
  event_type:
    "purchase" | "fulfillment" | "refund" | "cancellation" | "unknown";
}

export interface GmailLiveReceiptScanCoverage {
  source: "gmail_live";
  listed_count: number;
  candidate_count: number;
  matched_count: number;
  pages_scanned: number;
  max_messages: number;
  max_pages: number;
  reached_limit: boolean;
  query_scope: "receipt_signals_all_mail_except_spam_trash";
  rejection_counts: {
    missing_receipt_signal: number;
    extractor_not_receipt: number;
  };
  evidence_counts: {
    gmail_category: number;
    subject_signal: number;
    body_signal: number;
    verified_merchant: number;
    order_candidate: number;
    total_candidate: number;
  };
}

export interface GmailLiveReceiptScanResponse {
  next_cursor?: string | null;
  items: GmailLiveReceiptItem[];
  page: number;
  per_page: number;
  returned_count: number;
  has_more: boolean;
  coverage: GmailLiveReceiptScanCoverage;
}

export interface GmailReceiptEmailExcerpt {
  kind: "email_excerpt";
  label: "Email preview";
  text: string;
  truncated: boolean;
}

export interface GmailReceiptSourceEvidence {
  kind:
    | "merchant"
    | "category"
    | "amount"
    | "document"
    | "status"
    | "recurrence"
    | "attention";
  text: string;
}

export interface GmailLiveReceiptDetailResponse {
  item: GmailLiveReceiptItem;
  email_excerpt: GmailReceiptEmailExcerpt | null;
  source_evidence: GmailReceiptSourceEvidence[];
}

export type GmailNudgeType = "needs_reply" | "upcoming_meeting";

export interface GmailNudge {
  type: GmailNudgeType;
  thread_id: string;
  message_id: string;
  title: string;
  sender: string;
  sender_email: string;
  received_at: string | null;
  /** Meeting start time for upcoming_meeting nudges; null otherwise. */
  starts_at?: string | null;
  /** Conferencing "join" link for upcoming_meeting nudges; null when unavailable. */
  meeting_url?: string | null;
}

export interface GmailNudgesResponse {
  user_id: string;
  account_email: string | null;
  nudges: GmailNudge[];
}

interface ErrorEnvelope {
  detail?:
    | string
    | {
        message?: string;
        code?: string;
      };
  message?: string;
  error?: string;
}

export class GmailReceiptRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "GmailReceiptRequestError";
    this.status = status;
    this.code = code;
  }
}

export function isReceiptScanInProgressError(
  error: unknown,
): error is GmailReceiptRequestError {
  return (
    error instanceof GmailReceiptRequestError &&
    error.status === 409 &&
    error.code === "GMAIL_RECEIPT_SCAN_IN_PROGRESS"
  );
}

// A page that failed for one of these reasons can be read again with the same
// signed cursor; every value is still fully validated. Authority, vault,
// connection-required and continuation errors are never retried here.
const RETRYABLE_RECEIPT_SCAN_CODES = new Set([
  "GMAIL_CONNECTION_CHANGED",
  "GMAIL_PROVIDER_UNAVAILABLE",
  "GMAIL_RECEIPT_SCAN_TIMEOUT",
  "GMAIL_RECEIPT_EXTRACTION_TIMEOUT",
  "GMAIL_RECEIPT_EXTRACTION_UNAVAILABLE",
  "GMAIL_RECEIPT_EXTRACTION_INVALID",
  "GMAIL_RECEIPT_EXTRACTION_UNVERIFIED",
]);

export function isRetryableReceiptScanPageError(
  error: unknown,
): error is GmailReceiptRequestError {
  return (
    error instanceof GmailReceiptRequestError &&
    RETRYABLE_RECEIPT_SCAN_CODES.has(String(error.code))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function invalidLiveReceiptResponse(): Error {
  return new Error("Mail receipt scan returned an invalid response.");
}

function isSourceEvidenceList(value: unknown): value is GmailReceiptSourceEvidence[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        [
          "merchant",
          "category",
          "amount",
          "document",
          "status",
          "recurrence",
          "attention",
        ].includes(String(entry.kind)) &&
        typeof entry.text === "string" &&
        entry.text.trim().length >= 3 &&
        entry.text.length <= 240 &&
        !/https?:\/\/|www\.|mailto:/i.test(entry.text),
    )
  );
}

function parseLiveReceiptItem(value: unknown): GmailLiveReceiptItem {
  if (!isRecord(value)) throw invalidLiveReceiptResponse();
  if (value.source_evidence != null && !isSourceEvidenceList(value.source_evidence)) {
    throw invalidLiveReceiptResponse();
  }
  if (
    (value.document_kind != null && !["invoice", "receipt", "payment_confirmation", "order_confirmation", "booking", "fulfillment"].includes(String(value.document_kind))) ||
    (value.identifiers != null && (!Array.isArray(value.identifiers) || value.identifiers.length > 9 || value.identifiers.some(
      (item: unknown) => !isRecord(item) || !["order", "invoice", "receipt", "pnr", "payment"].includes(String(item.kind)) || typeof item.value !== "string" || !item.value.trim() || item.value.length > 100,
    )))
  ) throw invalidLiveReceiptResponse();
  if (
    (value.status != null && !["paid", "overdue", "refunded", "cancelled", "trial", "delivered", "payment_failed", "suspended", "renewal_due"].includes(String(value.status))) ||
    (value.recurrence != null && !["recurring", "one_time", "unknown"].includes(String(value.recurrence))) ||
    (value.attention_state != null && !["none", "needs_attention", "coming_up", "needs_review"].includes(String(value.attention_state))) ||
    (value.attention_reason != null && !["overdue", "payment_failed", "suspended", "renewal_due", "low_confidence"].includes(String(value.attention_reason))) ||
    (value.attention_is_prediction != null && typeof value.attention_is_prediction !== "boolean") ||
    (value.identifier_kind != null && !["order", "invoice", "receipt", "pnr"].includes(String(value.identifier_kind))) ||
    ["identifier_value", "short_detail", "cleaned_preview", "transaction_date", "attention_date"].some(
      (key) => value[key] != null && typeof value[key] !== "string",
    )
  ) throw invalidLiveReceiptResponse();
  const amount = value.amount;
  const confidence = value.classification_confidence;
  const eventType = value.event_type;
  if (
    value.category != null &&
    (![
      "Shopping",
      "Food",
      "Travel",
      "Transport",
      "Software & Subscriptions",
      "Cloud & Infra",
      "Subscription",
      "Bills",
      "Uncategorized",
      "Other",
    ].includes(String(value.category)) ||
      typeof value.category_confidence !== "number" ||
      !Number.isFinite(value.category_confidence) ||
      value.category_confidence < 0.85 ||
      value.category_confidence > 1)
  )
    throw invalidLiveReceiptResponse();
  if (
    !isIntegerInRange(value.id, Number.MIN_SAFE_INTEGER) ||
    typeof value.source_id !== "string" ||
    value.source_id.trim().length === 0 ||
    value.source_id.length > 340 ||
    value.receipt_key !== value.source_id ||
    value.source_kind !== "gmail_live" ||
    typeof value.gmail_message_id !== "string" ||
    value.gmail_message_id.trim().length === 0 ||
    !isNullableString(value.gmail_thread_id) ||
    !isNullableString(value.merchant_name) ||
    !isNullableString(value.merchant_domain) ||
    !isNullableString(value.sender_domain) ||
    !isNullableString(value.from_name) ||
    !isNullableString(value.from_email) ||
    !isNullableString(value.order_id) ||
    !isNullableString(value.currency) ||
    (value.currency !== null &&
      !["INR", "USD", "EUR", "GBP", "$"].includes(String(value.currency))) ||
    !isNullableString(value.receipt_date) ||
    !isNullableString(value.gmail_internal_date) ||
    !isNullableString(value.subject) ||
    !isNullableString(value.preview) ||
    !isNullableString(value.snippet) ||
    (amount !== null &&
      (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    value.classification_source !== "agent" ||
    !["purchase", "fulfillment", "refund", "cancellation", "unknown"].includes(
      String(eventType),
    )
  ) {
    throw invalidLiveReceiptResponse();
  }
  return value as unknown as GmailLiveReceiptItem;
}

function parseLiveReceiptScanResponse(
  payload: unknown,
  expected: { page: number; perPage: number },
): GmailLiveReceiptScanResponse {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidLiveReceiptResponse();
  }
  const items = payload.items.map(parseLiveReceiptItem);
  const coverage = payload.coverage;
  const rejectionCounts = isRecord(coverage) ? coverage.rejection_counts : null;
  const evidenceCounts = isRecord(coverage) ? coverage.evidence_counts : null;
  if (
    payload.page !== expected.page ||
    payload.per_page !== expected.perPage ||
    payload.returned_count !== items.length ||
    typeof payload.has_more !== "boolean" ||
    !isRecord(coverage) ||
    coverage.source !== "gmail_live" ||
    !isIntegerInRange(coverage.listed_count, 0, MAX_LIVE_RECEIPTS_PER_PAGE) ||
    !isIntegerInRange(
      coverage.candidate_count,
      0,
      MAX_LIVE_RECEIPTS_PER_PAGE,
    ) ||
    !isIntegerInRange(coverage.matched_count, 0, MAX_LIVE_RECEIPTS_PER_PAGE) ||
    !isIntegerInRange(coverage.pages_scanned, 1, expected.page) ||
    !isIntegerInRange(coverage.max_messages, 1, MAX_LIVE_RECEIPTS_PER_PAGE) ||
    coverage.max_messages !== expected.perPage ||
    ![10, 50].includes(Number(coverage.max_pages)) ||
    (coverage.max_pages === 50 && payload.has_more && !payload.next_cursor) ||
    (payload.next_cursor != null && (typeof payload.next_cursor !== "string" || payload.next_cursor.length > 8192)) ||
    typeof coverage.reached_limit !== "boolean" ||
    (coverage.reached_limit &&
      (expected.page !== coverage.max_pages || payload.has_more)) ||
    (expected.page === coverage.max_pages && payload.has_more) ||
    coverage.query_scope !== "receipt_signals_all_mail_except_spam_trash" ||
    coverage.matched_count !== items.length ||
    !isRecord(rejectionCounts) ||
    !isIntegerInRange(
      rejectionCounts.missing_receipt_signal,
      0,
      MAX_LIVE_RECEIPTS_PER_PAGE,
    ) ||
    !isIntegerInRange(
      rejectionCounts.extractor_not_receipt,
      0,
      MAX_LIVE_RECEIPTS_PER_PAGE,
    ) ||
    rejectionCounts.missing_receipt_signal +
      rejectionCounts.extractor_not_receipt +
      coverage.matched_count !==
      coverage.candidate_count ||
    !isRecord(evidenceCounts) ||
    ![
      evidenceCounts.gmail_category,
      evidenceCounts.subject_signal,
      evidenceCounts.body_signal,
      evidenceCounts.verified_merchant,
      evidenceCounts.order_candidate,
      evidenceCounts.total_candidate,
    ].every((value) =>
      isIntegerInRange(value, 0, coverage.candidate_count as number),
    )
  ) {
    throw invalidLiveReceiptResponse();
  }
  return {
    items,
    page: expected.page,
    per_page: expected.perPage,
    returned_count: items.length,
    has_more: payload.has_more,
    coverage: coverage as unknown as GmailLiveReceiptScanCoverage,
    next_cursor: typeof payload.next_cursor === "string" ? payload.next_cursor : null,
  };
}

async function extractLiveReceiptError(
  response: Response,
  fallback: string,
): Promise<GmailReceiptRequestError> {
  const raw = await response.text().catch(() => "");
  let message = fallback;
  let code: string | null = null;
  try {
    const payload = (raw ? JSON.parse(raw) : null) as ErrorEnvelope | null;
    const detail =
      payload?.detail &&
      typeof payload.detail === "object" &&
      !Array.isArray(payload.detail)
        ? payload.detail
        : null;
    message = String(
      (typeof detail?.message === "string" ? detail.message : null) ||
        (typeof payload?.detail === "string" ? payload.detail : null) ||
        (typeof payload?.message === "string" ? payload.message : null) ||
        (typeof payload?.error === "string" ? payload.error : null) ||
        fallback,
    ).trim();
    code =
      typeof detail?.code === "string" && detail.code.length <= 100
        ? detail.code
        : null;
  } catch {
    message = raw.trim() || fallback;
  }
  return new GmailReceiptRequestError(message, response.status, code);
}

function parseLiveReceiptDetailResponse(
  payload: unknown,
  expectedSourceId: string,
): GmailLiveReceiptDetailResponse {
  if (!isRecord(payload)) throw invalidLiveReceiptResponse();
  const item = parseLiveReceiptItem(payload.item);
  if (item.source_id !== expectedSourceId) throw invalidLiveReceiptResponse();
  const sourceEvidence = payload.source_evidence ?? [];
  if (!isSourceEvidenceList(sourceEvidence)) {
    throw invalidLiveReceiptResponse();
  }
  const excerpt = payload.email_excerpt;
  if (excerpt === null) {
    return {
      item,
      email_excerpt: null,
      source_evidence: sourceEvidence,
    };
  }
  if (
    !isRecord(excerpt) ||
    excerpt.kind !== "email_excerpt" ||
    excerpt.label !== "Email preview" ||
    typeof excerpt.text !== "string" ||
    excerpt.text.length === 0 ||
    typeof excerpt.truncated !== "boolean"
  ) {
    throw invalidLiveReceiptResponse();
  }
  return {
    item,
    email_excerpt: excerpt as unknown as GmailReceiptEmailExcerpt,
    source_evidence: sourceEvidence,
  };
}

async function parseNativeConnectStartResponse(
  response: Response,
): Promise<GmailNativeConnectStartResponse> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.server_client_id !== "string" ||
    payload.server_client_id.trim().length === 0 ||
    (payload.purpose !== "read" && payload.purpose !== "send")
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailNativeConnectStartResponse;
}

async function parseConnectStartResponse(
  response: Response,
): Promise<GmailConnectStartResponse> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.authorize_url !== "string" ||
    payload.authorize_url.trim().length === 0 ||
    typeof payload.state !== "string" ||
    payload.state.trim().length === 0 ||
    typeof payload.redirect_uri !== "string" ||
    typeof payload.expires_at !== "string" ||
    payload.expires_at.trim().length === 0
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailConnectStartResponse;
}

async function parseConnectionStatus(
  response: Response,
): Promise<GmailConnectionStatus> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    payload.connected !== true ||
    payload.status !== "connected"
  ) {
    throw new Error("Mail OAuth completion returned an invalid response.");
  }
  return payload as unknown as GmailConnectionStatus;
}

async function extractError(
  response: Response,
  fallback: string,
): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const payload = (raw ? JSON.parse(raw) : null) as ErrorEnvelope | null;
    const detailObj =
      payload?.detail &&
      typeof payload.detail === "object" &&
      !Array.isArray(payload.detail)
        ? payload.detail
        : null;
    const message =
      (typeof detailObj?.message === "string" ? detailObj.message : null) ||
      (typeof payload?.detail === "string" ? payload.detail : null) ||
      (typeof payload?.message === "string" ? payload.message : null) ||
      (typeof payload?.error === "string" ? payload.error : null);
    return (message || fallback).trim();
  } catch {
    return raw.trim() || fallback;
  }
}

function buildSealedHeaders(
  idToken: string,
  vaultOwnerToken: string,
): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    "X-Hushh-Consent": `Bearer ${vaultOwnerToken}`,
  };
}

export class GmailReceiptsService {
  static async getStatus(params: {
    idToken: string;
    userId: string;
    /** Bypass the short-TTL cache when the caller needs guaranteed-fresh data. */
    force?: boolean;
  }): Promise<GmailConnectionStatus> {
    const cache = CacheService.getInstance();
    const cacheKey = gmailStatusCacheKey(params.userId);
    if (!params.force) {
      const cached = cache.get<GmailConnectionStatus>(cacheKey);
      if (cached) return cached;
    }

    const response = await ApiService.apiFetch(
      buildGmailStatusPath(params.userId),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail connector status."),
      );
    }

    const status = (await response.json()) as GmailConnectionStatus;
    cache.set(cacheKey, status, CACHE_TTL.SHORT);
    return status;
  }

  static async startConnect(params: {
    idToken: string;
    userId: string;
    loginHint?: string | null;
    includeGrantedScopes: boolean;
    purpose?: "read" | "send" | "compose" | "modify";
  }): Promise<GmailConnectStartResponse> {
    trackGmailEventForOwner(params.userId, "gmail_connect_started", {
      action: params.includeGrantedScopes ? "incremental" : "full",
      result: "success",
    });

    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({
            user_id: params.userId,
            login_hint: params.loginHint || null,
            include_granted_scopes: params.includeGrantedScopes,
            purpose: params.purpose || "read",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to start Mail OAuth."),
        );
      }
      const payload = await parseConnectStartResponse(response);
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "success",
      });
      return payload;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "error",
      });
      throw error;
    }
  }

  static async startNativeConnect(params: {
    idToken: string;
    userId: string;
    purpose?: "read" | "send" | "compose";
  }): Promise<GmailNativeConnectStartResponse> {
    trackGmailEventForOwner(params.userId, "gmail_connect_started", {
      action: params.purpose === "send" ? "incremental" : "full",
      result: "success",
    });
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectNativeStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({ purpose: params.purpose || "read" }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to start native Mail OAuth."),
        );
      }
      const payload = await parseNativeConnectStartResponse(response);
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "success",
      });
      return payload;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "error",
      });
      throw error;
    }
  }

  static async completeNativeConnect(params: {
    idToken: string;
    userId: string;
    serverAuthCode: string;
    purpose?: "read" | "send";
  }): Promise<GmailConnectionStatus> {
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectNativeComplete,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({
            user_id: params.userId,
            server_auth_code: params.serverAuthCode,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to complete native Mail OAuth."),
        );
      }
      const status = await parseConnectionStatus(response);
      if (params.purpose === "send" && status.send_permission_granted !== true) {
        throw new Error("Mail authorization did not grant sending permission.");
      }
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "complete",
        result: "success",
      });
      return status;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "complete",
        result: "error",
      });
      throw error;
    }
  }

  static recordConsentFailure(error: unknown, userId?: string): void {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code || "").trim().toUpperCase()
        : "";
    const payload = {
      action: "complete",
      result: code === "USER_CANCELLED" ? "expected_error" : "error",
    } as const;
    if (userId) {
      trackGmailEventForOwner(userId, "gmail_connect_result", payload);
    } else {
      trackEvent("gmail_connect_result", payload);
    }
  }

  static recordConnectCompletion(result: "success" | "error"): void {
    trackEvent("gmail_connect_result", {
      action: "complete",
      result,
    });
  }

  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
  }, options: { recordTelemetry?: boolean } = {}): Promise<GmailConnectionStatus> {
    const recordTelemetry = options.recordTelemetry !== false;
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectComplete,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({
            user_id: params.userId,
            code: params.code,
            state: params.state,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to complete Mail OAuth."),
        );
      }
      const status = await parseConnectionStatus(response);
      if (recordTelemetry) {
        trackGmailEventForOwner(params.userId, "gmail_connect_result", {
          action: "complete",
          result: "success",
        });
      }
      return status;
    } catch (error) {
      if (recordTelemetry) {
        trackGmailEventForOwner(params.userId, "gmail_connect_result", {
          action: "complete",
          result: "error",
        });
      }
      throw error;
    }
  }

  static async disconnect(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.disconnect,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_disconnect_result", { result: "error" });
      throw new Error(
        await extractError(response, "Failed to disconnect Mail."),
      );
    }

    trackGmailEventForOwner(params.userId, "gmail_disconnect_result", { result: "success" });
    return (await response.json()) as GmailConnectionStatus;
  }

  static async reconcile(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.reconcile,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(
          response,
          "Failed to refresh Mail connector status.",
        ),
      );
    }

    const status = (await response.json()) as GmailConnectionStatus;
    CacheService.getInstance().set(
      gmailStatusCacheKey(params.userId),
      status,
      CACHE_TTL.SHORT,
    );
    return status;
  }

  static async syncNow(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailSyncQueueResponse> {
    trackEvent("gmail_sync_requested", {
      action: "manual",
      result: "success",
    });

    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.sync,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_sync_result", {
        action: "queue",
        result: "error",
      });
      throw new Error(
        await extractError(response, "Failed to queue Mail receipt sync."),
      );
    }

    const payload = (await response.json()) as GmailSyncQueueResponse;
    trackGmailEventForOwner(params.userId, "gmail_sync_result", {
      action: payload.accepted ? "queue" : "already_running",
      result: payload.accepted ? "success" : "expected_error",
    });
    return payload;
  }

  static async getSyncRun(params: {
    idToken: string;
    userId: string;
    runId: string;
  }): Promise<{ run: GmailSyncRun }> {
    const query = new URLSearchParams({ user_id: params.userId }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailSyncRunPath(params.runId)}?${query}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail sync run status."),
      );
    }

    return (await response.json()) as { run: GmailSyncRun };
  }

  static async scanReceipts(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    page?: number;
    cursor?: string | null;
    perPage?: number;
    signal?: AbortSignal;
  }): Promise<GmailLiveReceiptScanResponse> {
    const page = Math.max(1, Math.min(50, Math.trunc(params.page ?? 1)));
    const perPage = Math.max(
      1,
      Math.min(
        MAX_LIVE_RECEIPTS_PER_PAGE,
        Math.trunc(params.perPage ?? MAX_LIVE_RECEIPTS_PER_PAGE),
      ),
    );
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.receiptsScan,
        {
          method: "POST",
          cache: "no-store",
          signal: params.signal,
          headers: {
            ...buildSealedHeaders(params.idToken, params.vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_id: params.userId,
            page,
            per_page: perPage,
            ...(params.cursor ? { cursor: params.cursor } : {}),
          }),
        },
      );
      if (!response.ok) {
        throw await extractLiveReceiptError(
          response,
          "Failed to scan Mail for receipts.",
        );
      }
      const payload: unknown = await response.json();
      const parsed = parseLiveReceiptScanResponse(payload, { page, perPage });
      trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
        result: "success",
      });
      return parsed;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
        result: "error",
      });
      throw error;
    }
  }

  static async getReceiptDetail(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    sourceId: string;
    signal?: AbortSignal;
  }): Promise<GmailLiveReceiptDetailResponse> {
    const sourceId = params.sourceId.trim();
    if (!sourceId || sourceId.length > 340) {
      throw new Error("The selected Mail receipt is not available.");
    }
    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.receiptDetail,
      {
        method: "POST",
        cache: "no-store",
        signal: params.signal,
        headers: {
          ...buildSealedHeaders(params.idToken, params.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          source_id: sourceId,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        await extractError(
          response,
          "Failed to load the selected Mail receipt.",
        ),
      );
    }
    const payload: unknown = await response.json();
    return parseLiveReceiptDetailResponse(payload, sourceId);
  }

  static async listReceipts(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    page?: number;
    perPage?: number;
  }): Promise<ReceiptListResponse> {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      per_page: String(params.perPage ?? 25),
    }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailReceiptsPath(params.userId)}?${query}`,
      {
        method: "GET",
        headers: buildSealedHeaders(params.idToken, params.vaultOwnerToken),
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
        result: "error",
      });
      throw new Error(
        await extractError(response, "Failed to load synced Mail receipts."),
      );
    }

    trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
      result: "success",
    });
    return (await response.json()) as ReceiptListResponse;
  }

  static async listNudges(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    limit?: number;
  }): Promise<GmailNudgesResponse> {
    const query = new URLSearchParams({
      limit: String(params.limit ?? 10),
    }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailNudgesPath(params.userId)}?${query}`,
      {
        method: "GET",
        headers: buildSealedHeaders(params.idToken, params.vaultOwnerToken),
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail nudges."),
      );
    }

    return (await response.json()) as GmailNudgesResponse;
  }
}
