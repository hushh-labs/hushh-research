import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(10_000);

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const body = await request.json().catch(() => ({}));

  try {
    const response = await fetch(
      `${getPythonApiUrl()}/api/consent/pending/opened`,
      {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(
      `[CONSENT API] request_id=${requestId} pending_opened_proxy_error`,
      error,
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to mark consent request opened" },
      { status: 500 },
    );
  }
}
