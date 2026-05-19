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

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const targetUrl = `${getPythonApiUrl()}/api/consent/handshake/history${request.nextUrl.search}`;

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(
      `[CONSENT API] request_id=${requestId} handshake_history_proxy_error`,
      error,
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to load consent handshake history" },
      { status: 500 },
    );
  }
}
