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
  const url = `${getPythonApiUrl()}/api/connectors${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);

    const response = await fetch(url, {
      method: "GET",
      headers,
    });
    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    console.error("[Connectors API] list_proxy_error", {
      request_id: requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return withRequestIdJson(
      requestId,
      {
        error: "Connectors temporarily unavailable",
        message: "The connector registry could not be loaded right now.",
      },
      { status: 502 }
    );
  }
}
