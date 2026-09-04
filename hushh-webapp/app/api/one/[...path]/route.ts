import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
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
const ONE_STREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(285_000, {
  developmentFloorMs: 285_000,
  overrideEnvKey: "HUSHH_ONE_STREAM_TIMEOUT_MS",
});

function requestTimeoutMs(path: string, acceptHeader: string | null): number {
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
  const voiceTurnIdHeader =
    request.headers.get("x-voice-turn-id") || request.headers.get("X-Voice-Turn-Id");
  const acceptHeader = request.headers.get("accept");
  const contentType = request.headers.get("content-type") || "";

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);
    if (hushhConsentHeader) headers.set("X-Hushh-Consent", hushhConsentHeader);
    if (acceptHeader) headers.set("Accept", acceptHeader);
    if (voiceTurnIdHeader) headers.set("X-Voice-Turn-Id", voiceTurnIdHeader);

    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      headers.set("Content-Type", contentType || "application/json");
      body = await request.text();
    }

    // Agent chat is an SSE connection. An AbortSignal.timeout stays attached to
    // the response body after fetch resolves, so it would cut off a valid
    // response mid-stream even while the backend is still sending keep-alives.
    // Let the browser disconnect signal own that stream's lifetime instead.
    const upstreamSignal =
      path === "agent-chat"
        ? request.signal
        : AbortSignal.timeout(requestTimeoutMs(path, acceptHeader));

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

    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, {
      status: response.status,
      headers: privateResponseHeaders(response),
    });
  } catch (error) {
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
