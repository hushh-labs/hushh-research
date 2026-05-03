import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return proxyRequest(request, params);
}

export async function DELETE(
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
  const url = `${getPythonApiUrl()}/api/ialphabets/${path}${queryString}`;

  const authHeader = request.headers.get("authorization");
  console.log(
    `[iAlphabets API] request_id=${requestId} method=${request.method} path=${path} auth=${Boolean(authHeader)}`
  );

  try {
    const headers = createUpstreamHeaders(requestId);

    if (authHeader) {
      headers.set("Authorization", authHeader);
    }

    let body: BodyInit | undefined;
    if (request.method === "GET" || request.method === "DELETE") {
      body = undefined;
    } else {
      headers.set("Content-Type", "application/json");
      body = await request.text();
    }

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        `[iAlphabets API] request_id=${requestId} upstream_status=${response.status} path=${path}`,
        data
      );
      return withRequestIdJson(requestId, data, { status: response.status });
    }

    return withRequestIdJson(requestId, data);
  } catch (error) {
    console.error(
      `[iAlphabets API] request_id=${requestId} proxy_error path=${path}`,
      error
    );
    return withRequestIdJson(
      requestId,
      { error: "Internal Proxy Error", details: String(error) },
      { status: 500 }
    );
  }
}
