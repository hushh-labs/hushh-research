import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type AccountExportRoute = {
  GET: (request: NextRequest) => Promise<Response>;
};

let route: AccountExportRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../app/api/account/export/route");
});

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/account/export", {
    method: "GET",
    headers,
  });
}

describe("GET /api/account/export proxy", () => {
  it("does not expose raw backend error text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("raw database failure with table names", { status: 500 })
    );

    const response = await route.GET(request({ Authorization: "Bearer HCT:test" }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "Failed to export account data" });
  });

  it("streams without buffering and propagates cancellation", async () => {
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
      cancel,
    }), { headers: { "Content-Type": "application/json" } });
    const readAll = vi.spyOn(upstream, "text");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const req = request({ Authorization: "Bearer HCT:test" });
    const response = await route.GET(req);
    expect(readAll).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetch).toHaveBeenCalledWith("http://backend.test/api/account/export", expect.objectContaining({
      signal: req.signal, cache: "no-store",
    }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"data":');
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves a mid-stream failure instead of manufacturing successful JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("synthetic stream interruption")); },
    }), { headers: { "Content-Type": "application/json" } }));
    const response = await route.GET(request({ Authorization: "Bearer HCT:test" }));
    await expect(response.json()).rejects.toThrow("synthetic stream interruption");
  });
});
