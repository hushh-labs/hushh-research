import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { ONE_CHAT_KEY_HEADER } from "@/lib/vault/one-chat-key";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const ONE_API_TIMEOUT_MS = resolveSlowRequestTimeoutMs(45_000, {
  developmentFloorMs: 45_000,
  overrideEnvKey: "HUSHH_ONE_API_TIMEOUT_MS",
});
const ONE_EMAIL_DRAFT_TIMEOUT_MS = resolveSlowRequestTimeoutMs(75_000, {
  developmentFloorMs: 75_000,
  overrideEnvKey: "HUSHH_ONE_EMAIL_DRAFT_TIMEOUT_MS",
});
// A KYC Inbox scan can classify up to 30 messages and safely replay a
// side-effect-free model turn after a transient provider failure. It must be
// allowed to return its persisted partial/full result instead of being cut off
// by the generic One API deadline.
const ONE_KYC_SCAN_TIMEOUT_MS = resolveSlowRequestTimeoutMs(90_000, {
  developmentFloorMs: 90_000,
  overrideEnvKey: "HUSHH_ONE_KYC_SCAN_TIMEOUT_MS",
});
const ONE_STREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(285_000, {
  developmentFloorMs: 285_000,
  overrideEnvKey: "HUSHH_ONE_STREAM_TIMEOUT_MS",
});

const CIRCLE_CHAT_MAX_REQUEST_BYTES = 7_250_000;
async function readCircleChatBody(request: NextRequest, maximum = CIRCLE_CHAT_MAX_REQUEST_BYTES): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new RangeError("Chat request is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, 30_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new RangeError("Chat request is too large");
      chunks.push(chunk.value);
    }
    if (timedOut) throw new DOMException("Chat request timed out", "TimeoutError");
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(body);
  } finally { clearTimeout(timeout); await reader.cancel(); reader.releaseLock(); }
}

function requestTimeoutMs(path: string, acceptHeader: string | null): number {
  if (path === "email/draft") return ONE_EMAIL_DRAFT_TIMEOUT_MS;
  if (path === "email/draft/save") return ONE_EMAIL_DRAFT_TIMEOUT_MS;
  if (path === "email/information-requests/scan") return ONE_KYC_SCAN_TIMEOUT_MS;
  const acceptsEventStream =
    acceptHeader?.toLowerCase().includes("text/event-stream") ?? false;
  const isKnownStreamRoute = path === "agent-chat" || path.endsWith("/stream");
  return acceptsEventStream || isKnownStreamRoute
    ? ONE_STREAM_TIMEOUT_MS
    : ONE_API_TIMEOUT_MS;
}

function privateResponseHeaders(upstream?: Response): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
  });
  if (!upstream) return headers;
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return headers;
}

function isUpstreamTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeCode =
    typeof (error as Error & { cause?: { code?: unknown } }).cause?.code === "string"
      ? (error as Error & { cause: { code: string } }).cause.code
      : "";
  const message = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT"
  );
}

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const url = `${getPythonApiUrl()}/api/one/${path}${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const hushhConsentHeader = request.headers.get("x-hushh-consent");
  // The owner's chat key (derived in the browser from the vault key). Chat
  // history is sealed with it; forwarded as-is and never logged or cached.
  const chatKeyHeader = request.headers.get(ONE_CHAT_KEY_HEADER);
  const voiceTurnIdHeader =
    request.headers.get("x-voice-turn-id") || request.headers.get("X-Voice-Turn-Id");
  const acceptHeader = request.headers.get("accept");
  const contentType = request.headers.get("content-type") || "";

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);
    if (hushhConsentHeader) headers.set("X-Hushh-Consent", hushhConsentHeader);
    if (chatKeyHeader) headers.set(ONE_CHAT_KEY_HEADER, chatKeyHeader);
    if (acceptHeader) headers.set("Accept", acceptHeader);
    if (voiceTurnIdHeader) headers.set("X-Voice-Turn-Id", voiceTurnIdHeader);

    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers.set("Content-Type", contentType || "application/json");
      body = (await (/^circles\/[^/]+\/photo$/.test(path) ? readCircleChatBody(request, 430000) :
        /^circles\/[^/]+\/chat(?:\/|$)/.test(path) ? readCircleChatBody(request) : request.text())) || undefined;
    }

    // Agent chat is an SSE connection. An AbortSignal.timeout stays attached to
    // the response body after fetch resolves, so it would cut off a valid
    // response mid-stream even while the backend is still sending keep-alives.
    // Let the browser disconnect signal own that stream's lifetime instead.
    const upstreamSignal =
      path === "agent-chat"
        ? request.signal
        : AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs(path, acceptHeader))]);

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: upstreamSignal,
    });

    // A streamed upstream must be handed through untouched. The JSON path below
    // buffers the whole body and swallows a parse failure into `{}`, which for
    // an event-stream means the caller receives an empty object with status 200
    // -- no frames, no error, and nothing to distinguish "the stream broke"
    // from "there was nothing to send". The Kai proxy passes streams through
    // for the same reason. Gated on the upstream content type, so every JSON
    // route on this proxy keeps the exact behaviour it had.
    const responseContentType = response.headers.get("content-type");
    if (responseContentType?.includes("text/event-stream")) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "private, no-store, no-cache, no-transform",
          Pragma: "no-cache",
          Connection: "keep-alive",
          // Stops a compressing hop buffering the body in order to encode it.
          "Content-Encoding": "none",
          "X-Accel-Buffering": "no",
          "x-request-id": requestId,
        },
      });
    }

    // The active-workflow read uses 204 to mean no unfinished run. Adding a
    // JSON body to that status throws and turns a valid empty state into 502.
    if (response.status === 204) {
      const headers = privateResponseHeaders(response);
      headers.set("x-request-id", requestId);
      return new Response(null, { status: 204, headers });
    }

    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, {
      status: response.status,
      headers: privateResponseHeaders(response),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return withRequestIdJson(requestId, { error: "Chat request is too large" },
        { status: 413, headers: privateResponseHeaders() });
    }
    const statusCode = isUpstreamTimeoutError(error) ? 504 : 502;
    return withRequestIdJson(
      requestId,
      {
        error: "One API unavailable",
        message: "The request could not be completed right now. Please try again.",
      },
      { status: statusCode, headers: privateResponseHeaders() }
    );
  }
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}
