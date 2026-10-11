/**
 * Consent SSE Events Proxy – integration tests
 *
 * Ensures GET /api/consent/events/[userId] proxies to the Python backend and
 * streams SSE correctly. Does not replace the existing consent flow (Sonner,
 * Pending tab, approve/deny); the proxy is additive for same-origin web.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createMockGET } from "../../utils/test-helpers";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

function authenticatedGET(path: string, params: Record<string, string>) {
  const request = createMockGET(path, params);
  request.headers.set("Authorization", "Bearer test-token");
  return request;
}

let eventsRoute: { GET: (req: NextRequest, ctx: { params: Promise<{ userId: string }> }) => Promise<Response> };

beforeEach(async () => {
  vi.restoreAllMocks();
  eventsRoute = await import("../../../app/api/consent/events/[userId]/route");
});

describe("GET /api/consent/events/[userId]", () => {
  it("returns 400 when userId is missing", async () => {
    const req = authenticatedGET("/api/consent/events/", {});
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/userId/i);
  });

  it("proxies to backend and streams response with SSE headers", async () => {
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: heartbeat\ndata: {}\n\n"));
        controller.close();
      },
    });
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const req = authenticatedGET("/api/consent/events/user_123", {});
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "user_123" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.test/api/consent/events/user_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        }),
      })
    );

    mockFetch.mockRestore();
  });

  it("returns backend status when backend returns non-OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("backend error", { status: 503 })
    );

    const req = authenticatedGET("/api/consent/events/user_123", {});
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "user_123" }),
    });

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toMatch(/connect to consent events stream/i);
  });

  it("returns 502 when backend returns OK but no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, body: null })
    );

    const req = authenticatedGET("/api/consent/events/user_123", {});
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "user_123" }),
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/No stream body/i);
  });
});

describe("stream proxy security", () => {
  it.each(["..", "../one/payouts", "a/b", "a\\b", "%2e%2e", "name?path=other", "name#fragment", "a\u0000b"])(
    "rejects an unsafe owner path before contacting the backend: %s", async (userId) => {
      const upstream = vi.spyOn(globalThis, "fetch");
      const response = await eventsRoute.GET(authenticatedGET("/api/consent/events/owner", {}), {
        params: Promise.resolve({ userId }),
      });
      expect(response.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects missing authorization before opening a stream", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const request = new NextRequest("http://localhost/api/consent/events/owner");
    const response = await eventsRoute.GET(request, { params: Promise.resolve({ userId: "owner" }) });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards cancellation, refuses redirects and never reflects provider errors", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("private upstream sentinel", { status: 503 }),
    );
    const request = authenticatedGET("/api/consent/events/owner", {});
    const response = await eventsRoute.GET(request, { params: Promise.resolve({ userId: "owner" }) });
    expect(upstream).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal: request.signal, redirect: "error", cache: "no-store",
    }));
    expect(await response.text()).not.toContain("private upstream sentinel");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects successful non-stream responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("login page", {
      headers: { "Content-Type": "text/html" },
    }));
    const response = await eventsRoute.GET(authenticatedGET("/api/consent/events/owner", {}), {
      params: Promise.resolve({ userId: "owner" }),
    });
    expect(response.status).toBe(502);
  });
});

it("opens the document Feed stream through its own fixed web route", async () => {
  const { GET } = await import("../../../app/api/consent/document-feed/[userId]/route");
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("event: feed_reset\ndata: {}\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const response = await GET(authenticatedGET("/api/consent/document-feed/owner", {}), {
    params: Promise.resolve({ userId: "owner" }),
  });
  expect(response.status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith("http://backend.test/api/consent/document-feed/owner", expect.any(Object));
});
