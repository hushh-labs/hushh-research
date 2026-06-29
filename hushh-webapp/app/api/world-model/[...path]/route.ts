import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

async function proxyWorldModelRequest(
  request: NextRequest,
  paramsPromise: Promise<{ path: string[] }>,
  method: "GET" | "POST" | "PUT" | "DELETE"
) {
  const requestId = resolveRequestId(request);

  try {
    const { path } = await paramsPromise;
    const pathStr = path.join("/");
    const query = request.nextUrl.search;
    const backendUrl = `${getPythonApiUrl()}/api/world-model/${pathStr}${query}`;

    const authHeader = request.headers.get("Authorization") || "";
    const headers = createUpstreamHeaders(requestId, {
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(method === "POST" || method === "PUT"
        ? { "Content-Type": "application/json" }
        : {}),
    });

    const body =
      method === "POST" || method === "PUT"
        ? JSON.stringify(await request.json().catch(() => ({})))
        : undefined;

    const response = await fetch(backendUrl, {
      method,
      headers,
      body,
    });

    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));

    return withRequestIdJson(requestId, payload, {
      status: response.status,
    });
  } catch (error) {
    console.error(
      `[WorldModel API] request_id=${requestId} method=${method} proxy_error`,
      error
    );
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy request to backend" },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyWorldModelRequest(request, params, "GET");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyWorldModelRequest(request, params, "POST");
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyWorldModelRequest(request, params, "DELETE");
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyWorldModelRequest(request, params, "PUT");
}
