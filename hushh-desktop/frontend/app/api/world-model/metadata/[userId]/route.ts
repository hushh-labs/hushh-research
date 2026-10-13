import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const requestId = resolveRequestId(request);

  try {
    const { userId } = await params;
    const authHeader = request.headers.get("Authorization") || "";
    const backendUrl = `${getPythonApiUrl()}/api/world-model/metadata/${userId}${request.nextUrl.search}`;

    const response = await fetch(backendUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
    });

    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, {
      status: response.status,
    });
  } catch (error) {
    console.error(
      `[WorldModel Metadata API] request_id=${requestId} proxy_error`,
      error
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy world model metadata request" },
      { status: 500 }
    );
  }
}
