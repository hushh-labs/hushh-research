import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { createRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { resolveClientVersion } from "@/lib/observability/client-version";

// Console-only projection. No payload, URL, identity, amount, or Error is emitted.
// Verified Dev/UAT/test only, including optimized UAT builds; independent of analytics sampling.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REQUEST = new RegExp(`^/api/connectors/google_drive/sharing/requests/(${UUID})(?:/([^?]*))?(?:\\?.*)?$`, "i");
const SEARCH = new RegExp(`^/api/connectors/google_drive/searches(?:/(${UUID})(?:/(stop|results))?)?(?:\\?.*)?$`, "i");
const ACTIONS = new Set(["review", "context", "allow", "price", "decline", "cancel", "delivery", "review-request", "search", "search/files", "search/start", "one-copy", "one-copy/revoke", "one-copy/activity"]);
const CODES = new Set([
  "invalid_argument", "invalid_response", "invalid_payment_amount", "request_failed",
  "request_unavailable", "request_expired", "request_changed", "request_already_decided",
  "review_changed", "session_changed", "owner_price_required", "owner_payout_required",
  "payout_unavailable", "sharing_unavailable", "connector_unavailable", "reconnect_required",
  "connection_changed", "connection_required", "verify_google_identity_required",
  "recipient_google_identity_required", "recipient_verified_email_required", "date_range_required",
  "provider_unavailable", "search_in_progress", "search_incomplete", "search_not_found",
  "request_already_accessible", "package_existing_access_requires_review", "payment_unavailable",
  "package_changed", "package_not_ready", "price_changed", "source_changed", "recipient_changed",
]);
const REASONS = new Set(["owner_copy_consent_missing", "owner_copy_consent_unexpected"]);
const STATES = new Set([
  "draft", "pending", "pending_owner", "preparing", "prepared", "ready", "approved", "allowed",
  "declined", "denied", "cancelled", "expired", "revoked", "unavailable", "partial", "completed",
  "queued", "running", "stopped", "failed", "limited", "sharing", "shared", "no_match",
  "not_required", "awaiting_payment", "checkout_open", "paid", "refunded",
]);
const EVALUATION = new Set(["pending", "running", "ready", "no_match", "failed", "obsolete"]);
const PAYMENT = new Set(["none", "awaiting_owner", "preparing", "payable", "link_expired", "request_expired", "paid", "refund_pending", "refunded", "partially_refunded", "closed"]);
const COPY_REASONS = new Set(["source_changed", "source_identity_unavailable", "download_restricted", "native_export_unavailable", "export_limit_or_download_restricted", "export_size_limit", "export_representation_changed", "original_range_unavailable", "upload_outcome_unknown", "copy_integrity_mismatch", "provider_unavailable", "authority_ended", "copy_unavailable", "verification_budget_exhausted"]);
const COPY_STAGES = new Set(["authority", "credential", "source_before", "export_before", "export_after", "copy", "source_after", "read", "verify", "publish"]);
const COPY_FIELDS = new Set(["id", "name", "mime", "identity", "size", "modified_time", "md5", "sha256", "head_revision", "export_revision", "body_length", "content_encoding", "range"]);
const seen = new Map<string, { fingerprint: string; at: number }>();
const TTL_MS = 10 * 60_000;
type Fields = Record<string, string | boolean | number>;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
async function tag(value: string): Promise<string> {
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch { return "unavailable"; }
}
function route(path: string, method = "GET"): { action: string; identifier: string } | null {
  const request = REQUEST.exec(path);
  if (request) {
    const suffix = request[2] || "status";
    if (new RegExp(`^one-copy/files/${UUID}/content$`, "i").test(suffix)) {
      const disposition = /\?disposition=(preview|download)$/.exec(path)?.[1];
      return disposition ? { action: `one_copy_${disposition}`, identifier: request[1]!.toLowerCase() } : null;
    }
    if (suffix === "payment" || suffix === "payment/checkout")
      return { action: suffix === "payment" ? "payment" : "checkout", identifier: request[1]!.toLowerCase() };
    if (suffix !== "status" && !ACTIONS.has(suffix)) return null;
    return { action: suffix.replaceAll("/", "_"), identifier: request[1]!.toLowerCase() };
  }
  const search = SEARCH.exec(path);
  if (search) return {
    action: search[2] === "results" ? "search_results" : search[2] === "stop" ? "search_stop"
      : search[1] ? "search_status" : method === "POST" ? "search_create" : "search_recent",
    identifier: search[1]?.toLowerCase() || "new",
  };
  if (path === "/api/connectors/google_drive/sharing/requests") return { action: "create", identifier: "new" };
  if (path === "/api/connectors/google_drive/sharing/recipient-identity") return { action: "recipient_identity", identifier: "new" };
  return null;
}
function projection(payload: unknown, terms: unknown, includeStates = false): Fields {
  const value = object(payload), input = object(terms), fields: Fields = {};
  const detail = object(value.detail), search = object(value.search);
  const evaluation = object(search.evaluation ?? value.evaluation);
  const payment = object(value.payment);
  for (const [key, state, allowed] of [
    ["state", value.status, STATES], ["search_state", search.status, STATES],
    ["evaluation_state", evaluation.status, EVALUATION], ["payment_state", payment.state, PAYMENT],
  ] as const) {
    if (includeStates && typeof state === "string" && allowed.has(state)) fields[key] = state;
  }
  for (const [key, state] of [
    ["copy_requested", value.oneCopyRequested ?? input.oneCopyRequested],
    ["copy_accepted", input.oneCopyAccepted], ["whole_dollar_price", value.wholeDollarPrice],
    ["owner_allowed", value.ownerAllowed], ["queue_delayed", value.queueDelayed],
  ] as const) if (typeof state === "boolean") fields[key] = state;
  if (input.amountCents !== undefined) fields.price_valid = input.amountCents === null || isValidDocumentRequestPriceCents(input.amountCents);
  const code = detail.code ?? value.errorCode;
  if (typeof code === "string" && CODES.has(code)) fields.code = code;
  if (typeof detail.reason === "string" && REASONS.has(detail.reason)) fields.reason = detail.reason;
  if (includeStates) {
    const coverage = object(search.coverage ?? value.coverage);
    const delivery = object(value.counts);
    for (const [key, count] of [
      ["retained_count", search.matched ?? value.matched],
      ["unshareable_count", search.unshareableCount ?? value.unshareableCount],
      ["newly_shared_count", delivery.shared], ["already_shared_count", delivery.alreadyShared],
      ["share_failed_count", delivery.failed], ["share_pending_count", delivery.pending],
    ] as const) if (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 10000) fields[key] = count;
    for (const [key, count, limit] of [
      ["provider_rows", coverage.providerRowsScanned, 1_000_000],
      ["provider_file_pages", coverage.providerFilePages, 1000],
      ["excluded_by_date_count", coverage.excludedByDateCount, 1_000_000],
    ] as const) if (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= limit) fields[key] = count;
    if (coverage.dateBasis === "activity_union" && coverage.datePolicy === "drive_activity_union_v1" && coverage.dateGateApplied === true && typeof coverage.fallbackActivated === "boolean") {
      fields.date_basis = "activity_union";
      fields.date_policy = "drive_activity_union_v1";
      fields.date_gate_applied = true;
      fields.fallback_activated = coverage.fallbackActivated;
    }
    const retryAt = search.nextRetryAt ?? value.nextRetryAt;
    if ((search.retryReason ?? value.retryReason) === "provider_unavailable" && typeof retryAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(retryAt) && Number.isFinite(Date.parse(retryAt))) {
      fields.retry_reason = "provider_unavailable";
      fields.next_retry_at = new Date(retryAt).toISOString();
    }
    if (coverage.dateBasis === "provider_query") {
      fields.date_basis = "provider_query";
      if (["created", "modified", "not_expressed"].includes(String(coverage.datePushdown))) fields.date_pushdown = String(coverage.datePushdown);
    }
    if (["owner", "recipient"].includes(String(value.actorRole)) && Array.isArray(value.files) && value.files.length <= 10000) {
      const files = value.files.map(object);
      if (files.every(file => ["preparing", "ready", "unavailable", "revoked"].includes(String(file.status)))) {
        for (const state of ["preparing", "ready", "unavailable", "revoked"]) fields[`copy_${state}_count`] = files.filter(file => file.status === state).length;
        fields.copy_metadata_time_changed_count = files.filter(file => file.sourceMetadataTimeChanged === true).length;
        for (const file of files) {
          if (typeof file.reason === "string" && COPY_REASONS.has(file.reason)) {
            const key = `copy_reason_${file.reason}_count`; fields[key] = Number(fields[key] ?? 0) + 1;
          }
          if (file.status !== "unavailable") continue;
          const diagnostic = object(file.copyDiagnostics);
          if (typeof diagnostic.stage !== "string" || !COPY_STAGES.has(diagnostic.stage) || !Array.isArray(diagnostic.mismatches) || diagnostic.mismatches.length > COPY_FIELDS.size || diagnostic.mismatches.some(field => typeof field !== "string" || !COPY_FIELDS.has(field))) continue;
          const key = `copy_failed_stage_${diagnostic.stage}_count`; fields[key] = Number(fields[key] ?? 0) + 1;
          for (const field of new Set<string>(diagnostic.mismatches)) {
            const key = `copy_mismatch_${field}_count`; fields[key] = Number(fields[key] ?? 0) + 1;
          }
        }
      }
    }
  }
  return fields;
}
function diagnosticEnvironment(): "development" | "uat" | "test" | null {
  const modes: Record<string, "development" | "uat"> = { dev: "development", development: "development", staging: "uat", uat: "uat" };
  const configured = [process.env.NEXT_PUBLIC_APP_ENV, process.env.NEXT_PUBLIC_OBSERVABILITY_ENV, process.env.NEXT_PUBLIC_ENVIRONMENT_MODE];
  const declared = configured
    .map(value => value?.trim().toLowerCase()).filter((value): value is string => !!value);
  if (declared.length) {
    const mode = Object.hasOwn(modes, declared[0]!) ? modes[declared[0]!] : undefined;
    return mode && declared.every(value => modes[value] === mode) ? mode : null;
  }
  if (configured.some(value => value !== undefined)) return null;
  return process.env.NODE_ENV === "test" ? "test" : process.env.NODE_ENV === "development" ? "development" : null;
}

function emit(action: string, fields: Fields, dedupe: boolean) {
  // Enforce at the sink too: asynchronous hashing must not outlive an allowed context.
  const environment = diagnosticEnvironment();
  if (!environment) return;
  // Logging is never a prerequisite for consent, payment, or delivery.
  try {
    const now = Date.now();
    const key = `${fields.drive_op}:${action}:${fields.outcome === "observed" ? "state" : "transport"}`;
    const state = { ...fields };
    delete state.request_tag;
    delete state.duration_ms;
    const fingerprint = JSON.stringify(state);
    const previous = seen.get(key);
    if (dedupe && previous?.fingerprint === fingerprint && now - previous.at < TTL_MS) return;
    for (const [entry, value] of seen) if (now - value.at >= TTL_MS) seen.delete(entry);
    if (seen.size >= 128) seen.delete(seen.keys().next().value!);
    seen.set(key, { fingerprint, at: now });
    const sink = fields.outcome === "rejected" || fields.outcome === "failed" ? console.warn : console.info;
    sink(`[DRIVE_REQUEST][${action.toUpperCase()}]`, { schema_version: 1, app_environment: environment, observed_at: new Date().toISOString(), app_version: resolveClientVersion(), ...fields });
  } catch { /* A console sink must not change the transaction. */ }
}

/** Trace the existing transport without reading an extra body or changing retries. */
export async function traceDriveRequest<T>(
  path: string,
  method: string,
  perform: (headers: Record<string, string>, observe: (response: Response, payload?: unknown) => void) => Promise<T>,
  terms?: unknown,
): Promise<T> {
  const target = route(path, method);
  if (!target) return perform({}, () => {});
  const environment = diagnosticEnvironment();
  const content = ["one_copy_preview", "one_copy_download"].includes(target.action);
  // Keep existing request correlation; disabled optional reader tracing adds no headers.
  if (!environment && content) return perform({}, () => {});
  const coalesce = method === "GET" && !content;
  const requestId = createRequestId();
  if (!environment) return perform({ [REQUEST_ID_HEADER]: requestId }, () => {});
  const tags = Promise.all([tag(target.identifier), tag(requestId)]).then(([operation, trace]) => ({ drive_op: operation!, request_tag: trace! } as Fields));
  const common: Fields = {};
  const started = performance.now();
  let status = 0;
  let observed: Fields = {};
  const observe = (response: Response, payload?: unknown) => {
    status = Number.isInteger(response.status) ? response.status : 0;
    observed = { ...observed, ...projection(payload, terms) };
    const build = response.headers?.get("x-hushh-deploy-sha");
    if (build && /^[a-f0-9]{40}$/.test(build)) common.build_sha = build;
  };
  const log = (fields: Fields) => {
    const snapshot = { ...common, ...fields };
    void tags.then(correlation => emit(target.action, { ...correlation, ...snapshot }, coalesce)).catch(() => {});
  };
  if (method !== "GET") log({ outcome: "started", ...projection(null, terms) });
  try {
    const value = await perform({ [REQUEST_ID_HEADER]: requestId }, observe);
    log({ ...observed, http_status: status, duration_ms: performance.now() - started,
      outcome: status === 202 ? "accepted" : "http_returned" });
    return value;
  } catch (error) {
    const cause = object(error);
    const code = typeof cause.code === "string" && CODES.has(cause.code) ? cause.code
      : typeof observed.code === "string" ? observed.code : "request_failed";
    log({ ...observed, code, http_status: status, duration_ms: performance.now() - started,
      outcome: code === "session_changed" || cause.name === "AbortError" ? "cancelled" : status >= 400 ? "rejected" : "failed" });
    throw error;
  }
}

/** Log only validated, current-session state; hashing cannot delay the caller. */
export function observeDriveRequestState(path: string, payload: unknown, guard: () => void): void {
  try {
  if (!diagnosticEnvironment()) return;
  const target = route(path);
  if (!target) return;
  const state = projection(payload, null, true);
  void tag(target.identifier).then(operation => {
    guard();
    emit(target.action, { drive_op: operation, outcome: "observed", ...state }, true);
  }).catch(() => {});
  } catch { /* Diagnostics cannot invalidate an otherwise valid response. */ }
}
