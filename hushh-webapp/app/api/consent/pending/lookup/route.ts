import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";

  if (!authHeader) {
    return withRequestIdJson(
      requestId,
      { error: "Authorization header required" },
      { status: 401 },
    );
  }

  try {
    const targetUrl = `${getPythonApiUrl()}/api/consent/pending/lookup${request.nextUrl.search}`;
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        Authorization: authHeader,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(
      `[CONSENT API] request_id=${requestId} pending_lookup_proxy_error`,
      error,
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to resolve pending consent requests" },
      { status: 500 },
    );
  }
}
