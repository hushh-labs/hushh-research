// __tests__/utils/test-helpers.ts

/**
 * Test Helper Utilities
 *
 * Common utilities for API route testing.
 */

import { NextRequest } from "next/server";

/** Simulate incremental, stalled or delayed SSE bodies with real abort handling. */
export function createSseResponse(parts: string[], signal?: AbortSignal | null, delayMs = 0) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let timer: ReturnType<typeof setTimeout>;
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.error(signal.reason);
      }, { once: true });
      const finish = () => {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      };
      if (parts.length) delayMs ? timer = setTimeout(finish, delayMs) : finish();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Create a mock NextRequest for testing
 */
export function createMockRequest(
  url: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const { method = "GET", body, headers = {} } = options;

  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set("Content-Type", "application/json");
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

/**
 * Create mock GET request with query params
 */
export function createMockGET(
  path: string,
  params: Record<string, string>,
  headers?: Record<string, string>
): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return createMockRequest(url.toString(), { method: "GET", headers });
}

/**
 * Create mock POST request with body
 */
export function createMockPOST(
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
): NextRequest {
  return createMockRequest(path, { method: "POST", body, headers });
}

/**
 * Assert response has expected status and error code
 */
export async function expectError(
  response: Response,
  status: number,
  code?: string
) {
  expect(response.status).toBe(status);

  if (code) {
    const data = await response.json();
    expect(data.code).toBe(code);
  }
}

/**
 * Assert response is successful
 */
export async function expectSuccess(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}

/**
 * Mock fetch to return specific response
 */
export function mockFetch(responseData: Record<string, unknown>, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
    text: async () => JSON.stringify(responseData),
  });
}

/**
 * Mock fetch to fail
 */
export function mockFetchError(error: string = "Network error") {
  (global.fetch as jest.Mock).mockRejectedValueOnce(new Error(error));
}
