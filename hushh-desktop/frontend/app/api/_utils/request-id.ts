import { NextRequest, NextResponse } from "next/server";

import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/observability/request-id";

export function resolveRequestId(request: NextRequest): string {
  return getOrCreateRequestId(request.headers);
}

export function createUpstreamHeaders(
  requestId: string,
  extraHeaders?: Record<string, string>
): Headers {
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, requestId);

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (!value) continue;
      headers.set(key, value);
    }
  }

  return headers;
}

export function withRequestIdJson(
  requestId: string,
  body: unknown,
  init?: ResponseInit
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export function withRequestIdResponse(
  requestId: string,
  response: Response
): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
