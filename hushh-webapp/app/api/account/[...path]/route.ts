import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const ACCOUNT_API_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000, {
  developmentFloorMs: 20_000,
  overrideEnvKey: "HUSHH_ACCOUNT_API_TIMEOUT_MS",
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
  const url = `${getPythonApiUrl()}/api/account/${path}${request.nextUrl.search}`;
  const authHeader = request.headers.get("authorization");
  const contentType = request.headers.get("content-type") || "";

  try {
    const headers = createUpstreamHeaders(requestId);
    if (authHeader) headers.set("Authorization", authHeader);

    let body: BodyInit | undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      headers.set("Content-Type", contentType || "application/json");
      body = await request.text();
    }

    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(ACCOUNT_API_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    const statusCode = isUpstreamTimeoutError(error) ? 504 : 502;
    return withRequestIdJson(
      requestId,
      {
        error: "Account API unavailable",
        message: "The account request could not be completed right now.",
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
