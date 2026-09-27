import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(15_000);

/**
 * Disconnect an RIA relationship (and revoke the grants it carries).
 *
 * The RIA client workspace's Disconnect button posts here. With no route the web
 * app answered 404 and the relationship and its grants stayed in place. Native
 * builds call the backend directly and were unaffected.
 */
export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const targetUrl = `${getPythonApiUrl()}/api/consent/relationships/disconnect`;

  try {
    const body = await request.text();
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(
      `[CONSENT API] request_id=${requestId} relationship_disconnect_proxy_error`,
      error,
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to disconnect the relationship" },
      { status: 500 },
    );
  }
}
