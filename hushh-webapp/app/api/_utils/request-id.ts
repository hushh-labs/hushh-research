// hushh-webapp/lib/observability/request-id-utils.ts
import { NextRequest, NextResponse } from "next/server";

import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/observability/request-id";

/**
 * Resolves the unique Request ID for the current transaction.
 * Includes a warning to ensure tracing visibility within the Hushh ecosystem.
 */
export function resolveRequestId(request: NextRequest): string {
  const id = getOrCreateRequestId(request.headers);
  if (!id) {
    console.warn("[Hushh] Warning: Request ID could not be resolved. Tracing may be compromised.");
  }
  return id;
}

/**
 * Prepares headers for outbound/upstream API calls.
 * * @param requestId - The resolved tracing ID.
 * @param extraHeaders - Optional record or existing Headers object to merge.
 */
export function createUpstreamHeaders(
  requestId: string,
  extraHeaders?: Record<string, string> | Headers
): Headers {
  // Initialize with existing headers if provided, otherwise empty
  const headers = new Headers(extraHeaders instanceof Headers ? extraHeaders : undefined);

  // Set the Hushh tracing header
  headers.set(REQUEST_ID_HEADER, requestId);

  // If extraHeaders was a plain object, map it in
  if (extraHeaders && !(extraHeaders instanceof Headers)) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value) {
        headers.set(key, value);
      }
    }
  }

  return headers;
}

/**
 * Wraps a standard JSON body in a NextResponse with the Request ID header.
 */
export function withRequestIdJson(
  requestId: string,
  body: unknown,
  init?: ResponseInit
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * Clones an existing Response and injects the Request ID header.
 * * Fixed: Uses .clone() to ensure the original response body stream 
 * remains available for other consumers if necessary.
 */
export function withRequestIdResponse(
  requestId: string,
  response: Response
): Response {
  // Clone to avoid "Body has already been consumed" errors
  const clonedResponse = response.clone();

  // Create a fresh Headers object from the original response
  const newHeaders = new Headers(clonedResponse.headers);
  newHeaders.set(REQUEST_ID_HEADER, requestId);

  return new Response(clonedResponse.body, {
    status: clonedResponse.status,
    statusText: clonedResponse.statusText,
    headers: newHeaders,
  });
}