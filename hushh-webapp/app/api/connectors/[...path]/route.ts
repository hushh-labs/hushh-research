import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const queryString = request.nextUrl.search;
  const url = `${getPythonApiUrl()}/api/connectors/${path}${queryString}`;
  const authHeader = request.headers.get("authorization");
  const contentType = request.headers.get("content-type") || "";

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);

    let body: BodyInit | undefined;
    if (request.method === "POST") {
      headers.set("Content-Type", contentType.includes("application/json") ? contentType : "application/json");
      body = await request.text();
    }

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
    });
    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    console.error("[Connectors API] proxy_error", {
      request_id: requestId,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return withRequestIdJson(
      requestId,
      {
        error: "Connectors temporarily unavailable",
        message: "The connector request could not be completed right now.",
      },
      { status: 502 }
    );
  }
}
