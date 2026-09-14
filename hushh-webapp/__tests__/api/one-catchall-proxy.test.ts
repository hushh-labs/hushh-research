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
