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
  { params }: { params: Promise<{ path: string[] }> }
) {
  const requestId = resolveRequestId(request);

  try {
    const { path } = await params;
    const pathStr = path.join("/");
    const query = request.nextUrl.search;
    const targetUrl = `${getPythonApiUrl()}/api/marketplace/${pathStr}${query}`;
    const authHeader = request.headers.get("Authorization");

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
    });

    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[Marketplace API] request_id=${requestId} proxy_error`, error);
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy marketplace request" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const requestId = resolveRequestId(request);

  try {
    const { path } = await params;
    const pathStr = path.join("/");
    const targetUrl = `${getPythonApiUrl()}/api/marketplace/${pathStr}`;
    const authHeader = request.headers.get("Authorization");
    const body = await request.text();

    const response = await fetch(targetUrl, {
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
    console.error(`[Marketplace API] request_id=${requestId} proxy_error`, error);
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy marketplace request" },
      { status: 500 }
    );
  }
}
