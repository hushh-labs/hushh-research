import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const url = `${getPythonApiUrl()}/api/connected-systems${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const consentHeader =
    request.headers.get("x-hushh-consent") || request.headers.get("X-Hushh-Consent");

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);
    if (consentHeader) headers.set("X-Hushh-Consent", consentHeader);

    const response = await fetch(url, {
      method: "GET",
      headers,
    });
    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    console.error("[Connected Systems API] list_proxy_error", {
      request_id: requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return withRequestIdJson(
      requestId,
      {
        error: "Connected Systems temporarily unavailable",
        message: "The connected systems registry could not be loaded right now.",
      },
      { status: 502 }
    );
  }
}
