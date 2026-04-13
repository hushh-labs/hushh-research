import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
  withRequestIdResponse,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const GMAIL_PROXY_TIMEOUT_MS = resolveSlowRequestTimeoutMs(15_000, {
  developmentFloorMs: 15_000,
  overrideEnvKey: "HUSHH_KAI_GMAIL_TIMEOUT_MS",
});
const GMAIL_RECEIPTS_MEMORY_PREVIEW_TIMEOUT_MS = resolveSlowRequestTimeoutMs(45_000, {
  developmentFloorMs: 45_000,
  overrideEnvKey: "HUSHH_KAI_GMAIL_RECEIPTS_MEMORY_PREVIEW_TIMEOUT_MS",
});
const GMAIL_RECONCILE_TIMEOUT_MS = resolveSlowRequestTimeoutMs(30_000, {
  developmentFloorMs: 30_000,
  overrideEnvKey: "HUSHH_KAI_GMAIL_RECONCILE_TIMEOUT_MS",
});
const GMAIL_CONNECT_COMPLETE_TIMEOUT_MS = resolveSlowRequestTimeoutMs(30_000, {
  developmentFloorMs: 30_000,
  overrideEnvKey: "HUSHH_KAI_GMAIL_CONNECT_COMPLETE_TIMEOUT_MS",
});

function isGmailPath(path: string): boolean {
  return path === "gmail" || path.startsWith("gmail/");
}

function isUpstreamTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalizedMessage = error.message.toLowerCase();
  const causeCode =
    typeof (error as Error & { cause?: { code?: unknown } }).cause?.code === "string"
      ? (error as Error & { cause: { code: string } }).cause.code
      : "";
  return (
    error.name === "TimeoutError" ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("timeout") ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT"
  );
}

function buildUpstreamFailurePayload(path: string, error: unknown) {
  if (!isGmailPath(path)) {
    return {
      error: "Upstream request failed",
      message: "The request could not be completed right now. Please try again.",
    };
  }

  if (path === "gmail/sync") {
    return {
      error: "Gmail sync unavailable",
      message: "We couldn't start Gmail sync right now. Please try again in a moment.",
    };
  }

  if (path === "gmail/reconcile") {
    return {
      error: "Gmail refresh unavailable",
      message: isUpstreamTimeoutError(error)
        ? "Gmail is taking a little longer to refresh right now. Please try again in a moment."
        : "We couldn't refresh your Gmail connection right now. Please try again in a moment.",
    };
  }

  if (path.startsWith("gmail/status/")) {
    return {
      error: "Gmail status unavailable",
      message: "We couldn't check your Gmail connection right now. Please try again in a moment.",
    };
  }

  if (path.startsWith("gmail/receipts-memory/")) {
    return {
      error: "Receipt summary unavailable",
      message: "We couldn't create your shopping summary right now. Please try again in a moment.",
    };
  }

  if (path.startsWith("gmail/receipts/")) {
    return {
      error: "Receipts unavailable",
      message: "We couldn't load your receipts right now. Please try again in a moment.",
    };
  }

  return {
    error: "Gmail temporarily unavailable",
    message: isUpstreamTimeoutError(error)
      ? "Gmail is taking too long to respond right now. Please try again in a moment."
      : "Gmail is temporarily unavailable. Please try again in a moment.",
  };
}

function resolveKaiUpstreamTimeoutMs(path: string): number | null {
  if (path === "gmail/receipts-memory/preview") {
    return GMAIL_RECEIPTS_MEMORY_PREVIEW_TIMEOUT_MS;
  }
  if (path === "gmail/reconcile") {
    return GMAIL_RECONCILE_TIMEOUT_MS;
  }
  if (path === "gmail/connect/complete") {
    return GMAIL_CONNECT_COMPLETE_TIMEOUT_MS;
  }
  if (isGmailPath(path)) {
    return GMAIL_PROXY_TIMEOUT_MS;
  }
  return null;
}

function summarizeProxyError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const cause = error as Error & { cause?: { code?: unknown; message?: unknown } };
  return {
    name: error.name,
    message: error.message,
    causeCode: typeof cause.cause?.code === "string" ? cause.cause.code : undefined,
    causeMessage: typeof cause.cause?.message === "string" ? cause.cause.message : undefined,
  };
}

/**
 * Kai Catch-All Proxy
 *
 * Forwards all requests from /api/kai/* to the Python backend.
 * Supports:
 * - JSON requests (chat, analyze, etc.)
 * - Multipart form data (portfolio import)
 * - SSE streaming (analysis stream)
 */
export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  // Forward query string to backend
  const queryString = request.nextUrl.search;
  const url = `${getPythonApiUrl()}/api/kai/${path}${queryString}`;

  // Debug: Check if Authorization header is present
  const authHeader = request.headers.get("authorization");
  const acceptHeader = request.headers.get("accept");
  const voiceTurnIdHeader =
    request.headers.get("x-voice-turn-id") || request.headers.get("X-Voice-Turn-Id");
  const contentType = request.headers.get("content-type") || "";
  console.log(
    `[Kai API] request_id=${requestId} method=${request.method} path=${path} auth=${Boolean(authHeader)} content_type=${contentType || "none"}`
  );

  try {
    const headers = createUpstreamHeaders(requestId);
    
    // Copy authorization header
    if (authHeader) {
      headers.set("Authorization", authHeader);
    }
    if (acceptHeader) {
      headers.set("Accept", acceptHeader);
    }
    if (voiceTurnIdHeader) {
      headers.set("X-Voice-Turn-Id", voiceTurnIdHeader);
    }

    let body: BodyInit | undefined;
    
    // Handle different content types
    if (request.method === "GET" || request.method === "DELETE") {
      body = undefined;
    } else if (contentType.includes("multipart/form-data")) {
      // For file uploads, pass through the FormData
      // Don't set Content-Type - let fetch set it with boundary
      const formData = await request.formData();
      body = formData;
      console.log(`[Kai API] Forwarding multipart form data`);
    } else {
      // For JSON requests
      headers.set("Content-Type", "application/json");
      body = await request.text();
    }

    const upstreamTimeoutMs = resolveKaiUpstreamTimeoutMs(path);

    const response = await fetch(url, {
      method: request.method,
      headers: headers,
      body: body,
      ...(upstreamTimeoutMs ? { signal: AbortSignal.timeout(upstreamTimeoutMs) } : {}),
    });

    // Check for SSE stream response
    const responseContentType = response.headers.get("content-type");
    if (responseContentType?.includes("text/event-stream")) {
      console.log(`[Kai API] request_id=${requestId} sse_pass_through=true`);
      // Return SSE stream directly without parsing
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Content-Encoding": "none",
          "X-Accel-Buffering": "no",
          "x-request-id": requestId,
        },
      });
    }

    if (path === "voice/tts") {
      console.log(`[Kai API] request_id=${requestId} binary_pass_through=true path=${path}`);
      return withRequestIdResponse(requestId, response);
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const expectedAnalyzeRunMiss =
        path === "analyze/run/active" &&
        response.status === 404 &&
        typeof data === "object" &&
        data !== null &&
        typeof (data as { detail?: { code?: unknown } }).detail?.code === "string" &&
        (data as { detail: { code: string } }).detail.code === "ANALYZE_RUN_NOT_FOUND";
      if (expectedAnalyzeRunMiss) {
        console.info(
          `[Kai API] request_id=${requestId} no_active_analyze_run status=${response.status}`
        );
      } else {
        console.error(
          `[Kai API] request_id=${requestId} upstream_status=${response.status} path=${path}`,
          data
        );
      }
      return withRequestIdJson(requestId, data, { status: response.status });
    }

    return withRequestIdJson(requestId, data);
  } catch (error) {
    console.error(
      `[Kai API] request_id=${requestId} proxy_error path=${path}`,
      summarizeProxyError(error)
    );
    const statusCode = isUpstreamTimeoutError(error) ? 504 : 502;
    return withRequestIdJson(
      requestId,
      buildUpstreamFailurePayload(path, error),
      { status: statusCode }
    );
  }
}
