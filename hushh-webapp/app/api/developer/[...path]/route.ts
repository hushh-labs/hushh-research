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
  params: { path: string[] }
) {
  const requestId = resolveRequestId(request);
  const method = request.method;
  const query = request.nextUrl.search;
  const path = params.path.join("/");

  const isVersionedDeveloperApi = params.path[0] === "v1";
  const upstreamPath = isVersionedDeveloperApi
    ? `/api/${path}`
    : `/api/developer/${path}`;

  const targetUrl = `${getDeveloperApiUrl()}${upstreamPath}${query}`;

  // 1. Construct headers cleanly (Preserve original Content-Type if provided)
  const authHeader = request.headers.get("authorization");
  const contentType = request.headers.get("content-type");

  const customHeaders: Record<string, string> = {};
  if (!isVersionedDeveloperApi && authHeader) {
    customHeaders["Authorization"] = authHeader;
  }
  if (method !== "GET" && method !== "HEAD") {
    customHeaders["Content-Type"] = contentType || "application/json";
  }

  const headers = createUpstreamHeaders(requestId, customHeaders);

  // 2. Safely extract raw body without forced JSON mutation
  let body: string | undefined = undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await request.text().catch(() => "");
    if (!body) body = undefined; // Don't send empty string if body doesn't exist
  }

  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });

    // 3. Safely parse response (handles 204 No Content and empty bodies properly)
    const responseText = await response.text();
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch {
      // Fallback for plain text, HTML, or unexpected upstream errors
      payload = { detail: responseText };
    }

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
  return proxyDeveloperRequest(request, await params);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params);
}

// Easily export PUT and DELETE if your upstream API requires them:
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyDeveloperRequest(request, await params);
}