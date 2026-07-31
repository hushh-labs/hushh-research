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
  { params }: { params: Promise<{ token: string }> }
) {
  const requestId = resolveRequestId(request);

  try {
    const { token } = await params;
    const targetUrl = `${getPythonApiUrl()}/api/invites/${encodeURIComponent(token)}`;
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[Invites API] request_id=${requestId} proxy_error`, error);
    return withRequestIdJson(
      requestId,
      { error: "Failed to resolve invite" },
      { status: 500 }
    );
  }
}
