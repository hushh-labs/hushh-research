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
    expect(res.headers.get("Content-Encoding")).toBe("none");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.test/api/consent/events/user_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        }),
        signal: req.signal,
      })
    );

    mockFetch.mockRestore();
  });

  // Next decodes params before the route sees them, so "..%2F..%2F..%2Fdebug"
  // arrives as "../../../debug" and would normalise to the backend's /debug.
  it.each([
    "../../../debug/consent-listener",
    "a/b",
    "..",
    ".",
    "a\\b",
    "user?x=1",
    "user#frag",
    "user%2F..",
    "user\u0000",
    "user\u0085",
    "x".repeat(129),
  ])("refuses %j before reaching the backend", async (userId) => {
    const mockFetch = vi.spyOn(globalThis, "fetch");
    const req = createMockGET("/api/consent/events/x", {}, { authorization: "Bearer token" });
    const res = await eventsRoute.GET(req, { params: Promise.resolve({ userId }) });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/userId/i);
    expect(mockFetch).not.toHaveBeenCalled();
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

describe("document Feed stream through the proxy", () => {
  const sse = () => new Response("event: hello\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const route = () => import("../../../app/api/consent/document-feed/[userId]/route");

  it("forwards only a known protocol version and marks the stream so it ends before this server's timeout", async () => {
    const { GET } = await route();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse());
    const response = await GET(authenticatedGET("/api/consent/document-feed/owner", { v: "2", other: "../x" }), {
      params: Promise.resolve({ userId: "owner" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe("none");
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/api/consent/document-feed/owner?v=2");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token", "X-Hussh-Stream-Via": "next-proxy" });
  });

  it.each(["3", "2 ", "", "2&v=1", "../debug"])("refuses version %j before reaching the backend", async (v) => {
    const { GET } = await route();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await GET(authenticatedGET("/api/consent/document-feed/owner", { v }), {
      params: Promise.resolve({ userId: "owner" }),
    });
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes a busy backend's plain Retry-After on, and never marks the consent stream", async () => {
    const { GET } = await route();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", {
      status: 503, headers: { "Retry-After": "60" },
    }));
    const busy = await GET(authenticatedGET("/api/consent/document-feed/owner", { v: "2" }), {
      params: Promise.resolve({ userId: "owner" }),
    });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("60");

    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse());
    fetcher.mockClear();
    await eventsRoute.GET(authenticatedGET("/api/consent/events/owner", { v: "2" }), {
      params: Promise.resolve({ userId: "owner" }),
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/api/consent/events/owner");
    expect(init.headers).not.toHaveProperty("X-Hussh-Stream-Via");
  });
});
