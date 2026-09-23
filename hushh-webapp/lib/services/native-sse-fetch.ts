/**
 * A `fetch`-shaped streaming transport for the native shells.
 *
 * On web this is `ApiService.apiFetchStream`. On iOS and Android it drives
 * the HushhStream plugin: the request runs natively and its body bytes are
 * forwarded as they arrive, so a server-sent event stream reaches the page
 * token by token instead of as one buffered body (bug log B39: every native
 * call otherwise goes through CapacitorHttp, which returns whole bodies, and
 * WKWebView buffers `fetch()` bodies as well).
 *
 * The caller's headers travel unchanged (the vault-owner bearer among them);
 * the request id headers are added the way `apiFetch` adds them. Nothing is
 * parsed here: the returned `Response` carries a `ReadableStream<Uint8Array>`
 * of the raw bytes, which is what `@ag-ui/client`'s HttpAgent consumes.
 */

import { Capacitor } from "@capacitor/core";

import { ApiService } from "@/lib/services/api-service";
import {
  HUSHH_STREAM_EVENT,
  HushhStream,
  type HushhStreamEvent,
} from "@/lib/capacitor/stream";
import {
  getOrCreateRequestId,
  getOrCreateRequestTimestampMs,
  REQUEST_ID_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "@/lib/observability/request-id";
import {
  authSessionInvalidationCodeFromBackendPayload,
  dispatchAuthSessionInvalidated,
  isAccountDeletionInProgressBackendPayload,
} from "@/lib/auth/session-invalidation";
import {
  type AuthSessionOwnerSnapshot,
  dispatchAuthSessionVerificationRequired,
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

/** Same event name `vault-context.tsx` listens for; the API service dispatches it too. */
const VAULT_LOCK_REQUESTED_EVENT = "vault-lock-requested";

/** Backend lifecycle codes that mean "this session is over", by the status they ride on. */
const LIFECYCLE_STATUS_BY_CODE: Record<string, number> = {
  AUTH_ACCOUNT_NOT_FOUND: 401,
  AUTH_ACCOUNT_DELETION_IN_PROGRESS: 423,
  AUTH_ACCOUNT_STATUS_UNAVAILABLE: 503,
};

type StreamOwner = (AuthSessionOwnerSnapshot & { vaultEpoch: number }) | null;

function flattenHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key)] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function bearerOf(headers: Record<string, string>): string {
  const raw = headers.Authorization || headers.authorization || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bounded walk for a lifecycle code anywhere in a small backend payload. */
function payloadCarriesCode(payload: unknown, code: string, depth = 0): boolean {
  if (depth > 6 || payload === null || payload === undefined) return false;
  if (typeof payload === "string") return payload === code;
  if (typeof payload !== "object") return false;
  const values = Array.isArray(payload) ? payload : Object.values(payload as Record<string, unknown>);
  return values.slice(0, 64).some((value) => payloadCarriesCode(value, code, depth + 1));
}

function snapshotStreamOwner(): StreamOwner {
  const owner = snapshotValidatedAuthSessionOwner();
  return owner ? { ...owner, vaultEpoch: snapshotVaultSessionEpoch() } : null;
}

/**
 * The bridge code the native Kai stream would have produced for this
 * response (`KaiStreamLifecycleErrorClassifier.bridgeCode`), computed here
 * from the status and the drained body so both transports settle auth
 * failures identically.
 */
export function streamBridgeErrorCode(status: number, body: string): string {
  let payload: unknown = null;
  if (body && body.length <= 16 * 1024) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }
  const lifecycle =
    payload && isAccountDeletionInProgressBackendPayload(payload)
      ? "AUTH_ACCOUNT_DELETION_IN_PROGRESS"
      : payload && authSessionInvalidationCodeFromBackendPayload(payload) === "account_not_found"
        ? "AUTH_ACCOUNT_NOT_FOUND"
        : payload && payloadCarriesCode(payload, "AUTH_ACCOUNT_STATUS_UNAVAILABLE")
          ? "AUTH_ACCOUNT_STATUS_UNAVAILABLE"
          : null;
  if (lifecycle && LIFECYCLE_STATUS_BY_CODE[lifecycle] === status) return lifecycle;
  if (status === 401 || status === 403) return "AUTH_VAULT_OWNER_INVALID";
  return `HUSHH_HTTP_${status}`;
}

/**
 * Settle an auth failure the way `handleNativeVaultOwnerStreamError` does in
 * the API service: every side effect is bound to the identity that started
 * the stream, so a late failure from Account A never signs out Account B.
 */
export function settleStreamAuthFailure(
  path: string,
  status: number,
  body: string,
  requestOwner: StreamOwner,
): void {
  if (!requestOwner || !isValidatedAuthSessionOwnerCurrent(requestOwner)) return;
  const code = streamBridgeErrorCode(status, body);
  if (code === "AUTH_ACCOUNT_NOT_FOUND") {
    dispatchAuthSessionInvalidated({
      code: "account_not_found",
      path,
      userId: requestOwner.userId,
    });
    return;
  }
  if (code === "AUTH_ACCOUNT_STATUS_UNAVAILABLE" || code === "AUTH_ACCOUNT_DELETION_IN_PROGRESS") {
    dispatchAuthSessionVerificationRequired(requestOwner, code);
    return;
  }
  if (code === "AUTH_VAULT_OWNER_INVALID" && isVaultSessionEpochCurrent(requestOwner.vaultEpoch)) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(VAULT_LOCK_REQUESTED_EVENT, { detail: { reason: code, path } }),
    );
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * `fetch`-compatible streaming request. `path` is app-relative (`/api/...`)
 * or absolute; `init` is what a caller would hand to `fetch`, including the
 * `signal` that cancels the native request.
 */
export async function nativeStreamFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!Capacitor.isNativePlatform()) {
    return ApiService.apiFetchStream(path, init);
  }

  const headers = flattenHeaders(init.headers as HeadersInit | undefined);
  headers[REQUEST_ID_HEADER] = getOrCreateRequestId(headers);
  headers[REQUEST_TIMESTAMP_HEADER] = String(getOrCreateRequestTimestampMs(headers));
  if (!headers.Accept && !headers.accept) headers.Accept = "text/event-stream";
  const method = (init.method || "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : undefined;
  const requestOwner = bearerOf(headers).startsWith("HCT:") ? snapshotStreamOwner() : null;
  const streamId = crypto.randomUUID();
  const signal = init.signal ?? null;

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;
  let listener: { remove: () => void } | null = null;
  const pending: Uint8Array[] = [];

  const cleanup = () => {
    listener?.remove();
    listener = null;
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!controller) return;
    if (error) controller.error(error);
    else controller.close();
  };
  const onAbort = () => {
    void HushhStream.cancel({ streamId }).catch(() => undefined);
    finish(new DOMException("Aborted", "AbortError"));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const chunk of pending) streamController.enqueue(chunk);
      pending.length = 0;
    },
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      void HushhStream.cancel({ streamId }).catch(() => undefined);
    },
  });

  const onEvent = (event: HushhStreamEvent) => {
    if (event.streamId !== streamId || settled) return;
    if (event.type === "chunk") {
      if (!event.base64) return;
      const bytes = base64ToBytes(event.base64);
      if (controller) controller.enqueue(bytes);
      else pending.push(bytes);
      return;
    }
    if (event.error || (event.code && event.code !== "OK")) {
      const code = event.code || "NETWORK";
      finish(
        code === "CANCELLED"
          ? new DOMException("Aborted", "AbortError")
          : Object.assign(new Error(event.error || `Stream failed (${code})`), { code }),
      );
      return;
    }
    finish();
  };

  listener = await HushhStream.addListener(HUSHH_STREAM_EVENT, onEvent);
  signal?.addEventListener("abort", onAbort, { once: true });

  let opened: { status: number; headers: Record<string, string> };
  try {
    opened = await HushhStream.open({ streamId, path, method, headers, body });
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
    throw error instanceof Error ? error : new Error(String(error));
  }

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(opened.headers ?? {})) responseHeaders.set(key, value);
  if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "text/event-stream");

  if (opened.status >= 200 && opened.status < 300) {
    return new Response(stream, { status: opened.status, headers: responseHeaders });
  }

  // An error response is small and JSON; drain it so the caller gets the
  // body `fetch` would have given it, and settle the session the same way.
  const text = await readAll(stream).catch(() => "");
  settleStreamAuthFailure(path, opened.status, text, requestOwner);
  return new Response(text, { status: opened.status, headers: responseHeaders });
}
