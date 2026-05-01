import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const ONE_API_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000, {
  developmentFloorMs: 20_000,
  overrideEnvKey: "HUSHH_ONE_API_TIMEOUT_MS",
});

function isUpstreamTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeCode =
    typeof (error as Error & { cause?: { code?: unknown } }).cause?.code === "string"
      ? (error as Error & { cause: { code: string } }).cause.code
      : "";
  const message = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT"
  );
}

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const url = `${getPythonApiUrl()}/api/one/${path}${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const acceptHeader = request.headers.get("accept");
  const contentType = request.headers.get("content-type") || "";

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);
    if (acceptHeader) headers.set("Accept", acceptHeader);

    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      headers.set("Content-Type", contentType || "application/json");
      body = await request.text();
    }

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(ONE_API_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    const statusCode = isUpstreamTimeoutError(error) ? 504 : 502;
    return withRequestIdJson(
      requestId,
      {
        error: "One API unavailable",
        message: "The request could not be completed right now. Please try again.",
      },
      { status: statusCode }
    );
  }
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await props.params);
}
