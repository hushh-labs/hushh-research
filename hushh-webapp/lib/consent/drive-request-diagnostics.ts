import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { createRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { resolveClientVersion } from "@/lib/observability/client-version";

// Console-only projection. No payload, URL, identity, amount, or Error is emitted.
// Keep these records useful in release builds, independently of analytics sampling.
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
const seen = new Map<string, { fingerprint: string; at: number }>();
const TTL_MS = 10 * 60_000;
type Fields = Record<string, string | boolean | number>;
function enabled(): boolean {
  const environment = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (!["development", "dev", "uat"].includes(environment ?? "")) return false;
  // Never let a debug toggle or fallback relabel a production/unknown build.
  return ![process.env.NEXT_PUBLIC_OBSERVABILITY_ENV, process.env.NEXT_PUBLIC_ENVIRONMENT_MODE]
    .some(value => value && !["development", "dev", "uat", "staging"].includes(value.trim().toLowerCase()));
}
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
  return fields;
}
function emit(action: string, fields: Fields, dedupe: boolean) {
  // Logging is never a prerequisite for consent, payment, or delivery.
  try {
    if (!enabled()) return;
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
    sink(`[DRIVE_REQUEST][${action.toUpperCase()}]`, { schema_version: 1, app_version: resolveClientVersion(), ...fields });
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
  if (!target || !enabled()) return perform({}, () => {});
  const coalesce = method === "GET" && !["one_copy_preview", "one_copy_download"].includes(target.action);
  const requestId = createRequestId();
  const tags = Promise.all([tag(target.identifier), tag(requestId)]).then(([operation, trace]) => ({ drive_op: operation!, request_tag: trace! } as Fields));
  const common: Fields = {};
  const started = Date.now();
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
    log({ ...observed, http_status: status, duration_ms: Date.now() - started,
      outcome: status === 202 ? "accepted" : "http_returned" });
    return value;
  } catch (error) {
    const cause = object(error);
    const code = typeof cause.code === "string" && CODES.has(cause.code) ? cause.code
      : typeof observed.code === "string" ? observed.code : "request_failed";
    log({ ...observed, code, http_status: status, duration_ms: Date.now() - started,
      outcome: code === "session_changed" || cause.name === "AbortError" ? "cancelled" : status >= 400 ? "rejected" : "failed" });
    throw error;
  }
}

/** Log only validated, current-session state; hashing cannot delay the caller. */
export function observeDriveRequestState(path: string, payload: unknown, guard: () => void): void {
  const target = route(path);
  if (!target || !enabled()) return;
  const state = projection(payload, null, true);
  void tag(target.identifier).then(operation => {
    guard();
    emit(target.action, { drive_op: operation, outcome: "observed", ...state }, true);
  }).catch(() => {});
}
