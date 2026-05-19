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
  extraHeaders?: HeadersInit // Upgraded to support native Web API Headers
): Headers {
  // Natively merges any existing Headers, Record, or tuple array effortlessly
  const headers = new Headers(extraHeaders);
  headers.set(REQUEST_ID_HEADER, requestId);
  return headers;
}

export function withRequestIdJson<T = unknown>( // Added Generics for strict type safety
  requestId: string,
  body: T,
  init?: ResponseInit
): NextResponse<T> {
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

  // Safely passes the unconsumed body stream to prevent lock errors
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}