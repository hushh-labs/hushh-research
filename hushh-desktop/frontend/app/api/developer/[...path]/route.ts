import { NextRequest } from "next/server";

import { getDeveloperApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

async function proxyDeveloperRequest(
  request: NextRequest,
  params: { path: string[] },
  method: "GET" | "POST" | "PATCH"
) {
  const requestId = resolveRequestId(request);
  const query = request.nextUrl.search;
  const path = params.path.join("/");
  const isVersionedDeveloperApi = params.path[0] === "v1";
  const upstreamPath = isVersionedDeveloperApi
    ? `/api/${path}`
    : `/api/developer/${path}`;
  const targetUrl = `${getDeveloperApiUrl()}${upstreamPath}${query}`;

  const authHeader = request.headers.get("authorization") || "";
  const headers = createUpstreamHeaders(requestId, {
    ...(!isVersionedDeveloperApi && authHeader ? { Authorization: authHeader } : {}),
    ...(method === "POST" || method === "PATCH" ? { "Content-Type": "application/json" } : {}),
  });

  const body =
    method === "POST" || method === "PATCH"
      ? JSON.stringify(await request.json().catch(() => ({})))
      : undefined;

  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(`[Developer API] request_id=${requestId} proxy_error`, error);
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy developer request" },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params, "GET");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params, "POST");
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params, "PATCH");
}
