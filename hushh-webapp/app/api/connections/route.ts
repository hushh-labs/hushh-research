import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  try {
    const response = await fetch(`${BACKEND_URL}/api/one/connections`, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connections_list error:`, error);
    return withRequestIdJson(requestId, { items: [], degraded: true }, { status: 200 });
  }
}
