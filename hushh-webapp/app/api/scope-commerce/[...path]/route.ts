import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createUpstreamHeaders, resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const requestId = resolveRequestId(request);
  const authorization = request.headers.get("authorization");
  if (!authorization) return withRequestIdJson(requestId, { error: "Sign in to continue." }, { status: 401 });
  const { path } = await context.params;
  if (path.some(segment => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) {
    return withRequestIdJson(requestId, { error: "Invalid commerce request." }, { status: 400 });
  }
  try {
    const upstream = await fetch(`${getPythonApiUrl()}/api/scope-commerce/${path.join("/")}${request.nextUrl.search}`, {
      method: request.method,
      headers: createUpstreamHeaders(requestId, { Authorization: authorization, "Content-Type": "application/json" }),
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
      redirect: "error",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "private, no-store",
        "X-Request-ID": requestId,
      },
    });
  } catch {
    return withRequestIdJson(requestId, { error: "Payments could not be reached. Try again." }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
