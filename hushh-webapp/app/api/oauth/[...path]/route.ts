import { NextRequest } from "next/server";

import { getDeveloperApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

async function proxyOAuthRequest(
  request: NextRequest,
  params: { path: string[] },
  method: "POST"
) {
  const requestId = resolveRequestId(request);
  const targetUrl = `${getDeveloperApiUrl()}/oauth/${params.path.join("/")}${request.nextUrl.search}`;
  const authorization = request.headers.get("authorization") || "";
  const body = await request.text();

  try {
    const response = await fetch(targetUrl, {
      method,
      headers: createUpstreamHeaders(requestId, {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body ? { "Content-Type": request.headers.get("content-type") || "application/json" } : {}),
      }),
      body: body || undefined,
      cache: "no-store",
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return withRequestIdJson(requestId, { error: "OAuth request unavailable" }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyOAuthRequest(request, await params, "POST");
}
