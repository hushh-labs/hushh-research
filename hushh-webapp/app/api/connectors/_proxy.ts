import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const CONNECTOR_PROXY_TIMEOUT_MS = resolveSlowRequestTimeoutMs(45_000);
// Owner-initiated Drive work that runs synchronously in the request: document
// preparation, and an allowed question's single bounded search (~160 s).
const LONG_DRIVE_SHARING_POST =
  /^google_drive\/sharing\/(?:requests\/[0-9a-f-]{36}\/prepare|queries\/[0-9a-f-]{36}\/(?:allow|share)|owner-shares(?:\/[0-9a-f-]{36}\/share)?)$/;

// Streamed document preparation: stage names only (see drive_sharing.py). Its
// budget sits above the backend's 190 s stream deadline.
const DRIVE_PREPARE_STREAM =
  /^google_drive\/sharing\/requests\/[0-9a-f-]{36}\/prepare\/stream$/;
const DRIVE_PREPARE_STREAM_TIMEOUT_MS = 200_000;

/**
 * Forward frames while the caller reads, then keep draining the upstream after
 * the caller goes away. Ending the backend request would drop Cloud Run's CPU
 * mid-preparation; POST /prepare stays in flight after a closed tab the same way.
 */
function keepUpstreamAlive(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let forwarding = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!forwarding) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (forwarding) controller.error(error);
      }
    },
    cancel() {
      forwarding = false;
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // Discard: nobody is listening, but the backend must finish.
          }
        } catch {
          // Upstream ended or hit its timeout.
        }
      })();
    },
  });
}

function connectorPath(path: string[]): string {
  const suffix = path.map((segment) => encodeURIComponent(segment)).join("/");
  return suffix ? `/api/connectors/${suffix}` : "/api/connectors";
}

export async function proxyExternalConnectorRequest(
  request: NextRequest,
  path: string[],
): Promise<Response> {
  const requestId = resolveRequestId(request);
  const targetUrl = `${getPythonApiUrl()}${connectorPath(path)}${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const consentHeader = request.headers.get("x-hushh-consent");
  const contentType = request.headers.get("content-type") || "";
  const headers = createUpstreamHeaders(requestId);

  if (authHeader) headers.set("Authorization", authHeader);
  if (consentHeader) headers.set("X-Hushh-Consent", consentHeader);
  const joinedPath = path.join("/");
  const isPrepareStream =
    request.method === "POST" && DRIVE_PREPARE_STREAM.test(joinedPath);
  if (isPrepareStream) headers.set("Accept", "text/event-stream");

  let body: BodyInit | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set(
      "Content-Type",
      contentType.includes("application/json")
        ? contentType
        : "application/json",
    );
    body = await request.text();
  }

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      // Never request.signal for the stream: a closed tab must not end the
      // backend request (see keepUpstreamAlive).
      signal: AbortSignal.timeout(
        isPrepareStream
          ? DRIVE_PREPARE_STREAM_TIMEOUT_MS
          : request.method === "POST" && LONG_DRIVE_SHARING_POST.test(joinedPath)
            ? 170_000 : CONNECTOR_PROXY_TIMEOUT_MS,
      ),
    });
    // Hand the stream through untouched; JSON errors from the same route
    // (401/422) keep the buffered path below.
    if (
      isPrepareStream &&
      response.body &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      return new Response(keepUpstreamAlive(response.body), {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "private, no-store, no-cache, no-transform",
          Pragma: "no-cache",
          Connection: "keep-alive",
          "Content-Encoding": "none",
          "X-Accel-Buffering": "no",
          "x-request-id": requestId,
        },
      });
    }
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    console.error(`[Connectors API] request_id=${requestId} proxy_error`, {
      path: connectorPath(path),
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    return withRequestIdJson(
      requestId,
      {
        error: "External connectors temporarily unavailable",
        message: "The connector service could not be reached right now.",
      },
      { status: 502 },
    );
  }
}
