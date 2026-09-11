import { NextRequest } from "next/server";

import { getDeveloperApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
  withRequestIdResponse,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

async function proxyOAuthRequest(
  request: NextRequest,
  params: { path: string[] },
  method: "POST" | "GET" | "DELETE"
) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const reviewPath = /^authorize\/oar_[a-f0-9]{32}$/;
  const connectionPath = /^connections\/oar_[a-f0-9]{32}$/;
  const consumerPath = /^consumer-connections\/cmc_[a-f0-9]{32}$/;
  if (
    (method === "GET" && path !== "connections" && !reviewPath.test(path) && !consumerPath.test(path)) ||
    (method === "DELETE" && !connectionPath.test(path) && !consumerPath.test(path))
  ) {
    return withRequestIdJson(requestId, { error: "Not found" }, { status: 404 });
  }
  const targetUrl = `${getDeveloperApiUrl()}/oauth/${params.path.join("/")}${request.nextUrl.search}`;
  const authorization = request.headers.get("authorization") || "";
  const body = method === "POST" ? await request.text() : "";

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
    if (response.status === 204) {
      return withRequestIdResponse(requestId, new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      }));
    }
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyOAuthRequest(request, await params, "GET");
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyOAuthRequest(request, await params, "DELETE");
}
