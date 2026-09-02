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
    typeof (error as Error & { cause?: { code?: unknown } }).cause?.code ===
    "string"
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

/**
 * Per-path upstream timeout. `null` means "no proxy-imposed deadline": the
 * upstream fetch carries only the caller's own abort signal.
 *
 * The lifecycle stream MUST be null. Its segments are ~40s of held-open SSE,
 * and the previous blanket `AbortSignal.timeout(45_000)` was a live landmine
 * for any stream on this proxy: the passthrough branch below hands
 * `response.body` to the client with headers already flushed, so when the
 * timeout fired mid-body the catch could not run -- the client saw HTTP 200,
 * `text/event-stream`, some frames, then a reset, indistinguishable from a
 * clean close. Segmentation makes that survivable; this makes it not happen.
 *
 * Resolution is per-path, NOT via HUSHH_ONE_API_TIMEOUT_MS: that override is
 * read once at module scope and would unbound every JSON route on this proxy
 * at once, which is precisely the blanket behavior being retired.
 */
function resolveOneUpstreamTimeoutMs(
  path: string,
  acceptHeader: string | null,
): number | null {
  if (path === "pod/lifecycle/stream") {
    return null;
  }
  // Agent chat is an SSE connection. An AbortSignal.timeout stays attached to
  // the response body after fetch resolves, so it would cut off a valid
  // response mid-stream even while the backend is still sending keep-alives.
  // Let the browser disconnect signal own that stream's lifetime instead
  // (ported from main, 701a370d4).
  if (path === "agent-chat") {
    return null;
  }
  // The one-click cloud completion legitimately runs long: create project,
  // link billing, enable ten APIs, apply IAM, then wait for Google to settle
  // the fresh grant (the backend bounds that wait at 45s from ITS start).
  // Under the blanket 45s this proxy abandoned the call at the same instant
  // the backend emitted its typed "press Continue again" refusal, so the
  // browser showed a generic failure for a call that usually succeeds moments
  // later (audit finding, 2026-08-21). 55s keeps the whole chain inside the
  // web client's own 60s abort while letting the backend's answer arrive.
  if (path === "runtime/byoc/authorize/complete") {
    return 55_000;
  }
  // Streaming routes (agent-chat, any `/stream` endpoint, or a caller that
  // asks for text/event-stream) hold open far longer than a JSON call, so the
  // 45s API deadline would sever them mid-body. They get the stream budget.
  const acceptsEventStream =
    acceptHeader?.toLowerCase().includes("text/event-stream") ?? false;
  const isKnownStreamRoute = path === "agent-chat" || path.endsWith("/stream");
  if (acceptsEventStream || isKnownStreamRoute) {
    return ONE_STREAM_TIMEOUT_MS;
  }
  return ONE_API_TIMEOUT_MS;
}

/** The Kai proxy's signal resolution, ported verbatim in behavior: a null
 * timeout yields the bare request signal, so a client disconnect still cancels
 * the upstream fetch and nothing else does. */
function resolveUpstreamSignal(
  requestSignal: AbortSignal,
  timeoutMs: number | null,
): AbortSignal {
  if (!timeoutMs) {
    return requestSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const anySignal = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anySignal === "function") {
    return anySignal([requestSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason);
  };
  if (requestSignal.aborted) {
    abortFrom(requestSignal);
  } else if (timeoutSignal.aborted) {
    abortFrom(timeoutSignal);
  } else {
    requestSignal.addEventListener("abort", () => abortFrom(requestSignal), {
      once: true,
    });
    timeoutSignal.addEventListener("abort", () => abortFrom(timeoutSignal), {
      once: true,
    });
  }
  return controller.signal;
}

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const url = `${getPythonApiUrl()}/api/one/${path}${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const hushhConsentHeader = request.headers.get("x-hushh-consent");
  const voiceTurnIdHeader =
    request.headers.get("x-voice-turn-id") ||
    request.headers.get("X-Voice-Turn-Id");
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

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: resolveUpstreamSignal(
        request.signal,
        resolveOneUpstreamTimeoutMs(path, acceptHeader),
      ),
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
        message:
          "The request could not be completed right now. Please try again.",
      },
      { status: statusCode, headers: privateResponseHeaders() },
    );
  }
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, await props.params);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, await props.params);
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, await props.params);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, await props.params);
}
