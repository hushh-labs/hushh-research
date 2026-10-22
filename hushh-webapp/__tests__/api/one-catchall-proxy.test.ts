import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type ProxyHandler = (
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> },
) => Promise<Response>;

type OneCatchAllRoute = {
  GET: ProxyHandler;
  POST: ProxyHandler;
  DELETE: ProxyHandler;
  PUT?: ProxyHandler;
};

let route: OneCatchAllRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  route = await import("../../app/api/one/[...path]/route");
});

describe("/api/one/[...path] proxy", () => {
  it("forwards the authenticated combined Messages count without caching it", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ unreadCount: 137 }));
    const request = new NextRequest("http://localhost:3000/api/one/messages/unread-count", {
      headers: { Authorization: "Bearer owner-fixture" },
    });
    const response = await route.GET(request, { params: Promise.resolve({ path: ["messages", "unread-count"] }) });
    expect(await response.json()).toEqual({ unreadCount: 137 });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream.mock.calls[0][0]).toBe("http://backend.test/api/one/messages/unread-count");
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer owner-fixture");
  });

  it("gives only semantic Location proposals the longer upstream budget", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const [segments, expected] of [
      [["agent-chat", "proposals"], 140_000],
      [["agent-chat", "proposals", "typed"], 45_000],
    ] as const) {
      const request = new NextRequest(`http://localhost:3000/api/one/${segments.join("/")}`, {
        method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
      });
      await route.POST(request, { params: Promise.resolve({ path: [...segments] }) });
      expect(timeout).toHaveBeenLastCalledWith(expected);
    }
  });
  it("forwards owner-authorized Wallet network metadata with a private response", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] }), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } }));
    const body = JSON.stringify({ iinPrefix: "411111", panLength: 16 });
    const request = new NextRequest("http://localhost:3000/api/one/wallet/card-access/networks/resolve", {
      method: "POST", body,
      headers: { Authorization: "Bearer fixture", "X-Hushh-Consent": "owner-fixture", "Content-Type": "application/json" },
    });
    const response = await route.POST(request, { params: Promise.resolve({ path: ["wallet", "card-access", "networks", "resolve"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const options = upstream.mock.calls.at(-1)![1] as RequestInit;
    expect(options.body).toBe(body);
    expect(new Headers(options.headers).get("x-hushh-consent")).toBe("owner-fixture");
  });

  it("rejects oversized Wallet requests before contacting the backend", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    upstream.mockClear();
    const request = new NextRequest("http://localhost:3000/api/one/wallet/card-access/networks/resolve", {
      method: "POST", body: "x".repeat(16_385), headers: { "Content-Type": "application/json" },
    });
    const response = await route.POST(request, { params: Promise.resolve({ path: ["wallet", "card-access", "networks", "resolve"] }) });
    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("preserves the empty response when no Location onboarding run exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const request = new NextRequest("http://localhost:3000/api/one/workflows/location/onboarding/runs/active", {
      headers: { Authorization: "Bearer fixture", "x-request-id": "location-empty-run" },
    });
    const response = await route.GET(request, {
      params: Promise.resolve({ path: ["workflows", "location", "onboarding", "runs", "active"] }),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe("location-empty-run");
  });

  it("preserves DELETE command authority and keeps bodyless manual requests compatible", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ checkedOut: true }), { headers: { "Content-Type": "application/json" } }));
    const body = JSON.stringify({ commandOperationId: "a".repeat(64), presenceId: "00000000-0000-4000-8000-000000000001", presenceVersion: 3 });
    for (const payload of [body, undefined]) {
      const request = new NextRequest("http://localhost:3000/api/one/location/nearby-presence", {
        method: "DELETE", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: payload,
      });
      expect((await route.DELETE(request, { params: Promise.resolve({ path: ["location", "nearby-presence"] }) })).status).toBe(200);
      const options = upstream.mock.calls.at(-1)![1] as RequestInit;
      expect(options.method).toBe("DELETE");
      expect(options.body).toBe(payload);
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture");
    }
  });
  it("preserves an upstream private no-store policy for Circle codes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ circle: { id: "circle-1" } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      }),
    );
    const request = new NextRequest(
      "http://localhost:3000/api/one/location/circles/circle-1",
      {
        method: "GET",
        headers: { Authorization: "Bearer vault-owner-token" },
      },
    );

    const response = await route.GET(request, {
      params: Promise.resolve({
        path: ["location", "circles", "circle-1"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("forwards a circle wait disconnect to the upstream and retains its timeout", async () => {
    const controller = new AbortController();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"latestSequence":0,"changed":false}', { headers: { "Content-Type": "application/json" } }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const request = new NextRequest("http://localhost:3000/api/one/circles/00000000-0000-4000-8000-000000000001/chat/wait", { signal: controller.signal });
    await route.GET(request, { params: Promise.resolve({ path: ["circles", "00000000-0000-4000-8000-000000000001", "chat", "wait"] }) });
    const signal = (upstream.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(45_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("forwards PUT, so a settings write is not refused by the proxy", async () => {
    // The model preference write is a PUT. The proxy exported GET, POST, PATCH
    // and DELETE, so Next.js answered 405 before the request ever reached
    // FastAPI, and the picker could read a value it could never change.
    expect(typeof route.PUT).toBe("function");

    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ effective_model: "gemini-3.8-flash" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const request = new NextRequest("http://localhost:3000/api/one/models/preference", {
      method: "PUT",
      headers: {
        Authorization: "Bearer vault-owner-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model_id: "gemini-3.8-flash" }),
    });

    const response = await route.PUT!(request, {
      params: Promise.resolve({ path: ["models", "preference"] }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalled();
    expect((upstream.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
  });
});


it.each([
  [new TypeError("fetch failed"), 503, "calendar_backend_unavailable"],
  [new DOMException("Timed out", "TimeoutError"), 504, "calendar_backend_timeout"],
])("classifies Calendar availability proxy failures with request correlation: %s", async (error, status, reason) => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  const response = await route.POST(new NextRequest("http://localhost:3000/api/one/calendar/schedule/availability", {
    method: "POST", body: "{}", headers: { Authorization: "Bearer fixture", "x-request-id": "calendar-availability-check" },
  }), { params: Promise.resolve({ path: ["calendar", "schedule", "availability"] }) });
  expect(response.status).toBe(status);
  expect(response.headers.get("x-request-id")).toBe("calendar-availability-check");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ detail: { reason_code: reason } });
});
