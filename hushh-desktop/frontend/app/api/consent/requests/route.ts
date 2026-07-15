import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const body = JSON.stringify(await request.json().catch(() => ({})));

  try {
    const response = await fetch(`${getPythonApiUrl()}/api/consent/requests`, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      body,
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[CONSENT API] request_id=${requestId} create_request_proxy_error`, error);
    return withRequestIdJson(requestId, { error: "Failed to create consent request" }, { status: 500 });
  }
}
