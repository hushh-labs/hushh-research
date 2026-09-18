import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const CONNECTOR_PROXY_TIMEOUT_MS = resolveSlowRequestTimeoutMs(45_000);

function connectorPath(path: string[]): string {
  const suffix = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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
      signal: AbortSignal.timeout(CONNECTOR_PROXY_TIMEOUT_MS),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[Connectors API] request_id=${requestId} proxy_error`, {
      path: connectorPath(path),
      message: error instanceof Error ? error.message : String(error),
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
