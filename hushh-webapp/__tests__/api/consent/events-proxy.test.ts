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

let eventsRoute: { GET: (req: NextRequest, ctx: { params: Promise<{ userId: string }> }) => Promise<Response> };

beforeEach(async () => {
  vi.restoreAllMocks();
  eventsRoute = await import("../../../app/api/consent/events/[userId]/route");
});

describe("GET /api/consent/events/[userId]", () => {
  it("returns 400 when userId is missing", async () => {
    const req = createMockGET("/api/consent/events/", {});
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

    const req = createMockGET("/api/consent/events/user_123", {}, {
      Accept: "text/event-stream",
    });
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "user_123" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.test/api/consent/events/user_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          Accept: "text/event-stream",
        }),
      })
    );

    mockFetch.mockRestore();
  });

  it("returns backend status when backend returns non-OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("backend error", { status: 503 })
    );

    const req = createMockGET("/api/consent/events/user_123", {});
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

    const req = createMockGET("/api/consent/events/user_123", {});
    const res = await eventsRoute.GET(req, {
      params: Promise.resolve({ userId: "user_123" }),
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/No stream body/i);
  });
});
