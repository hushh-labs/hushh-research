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
  vi.resetModules();
  vi.restoreAllMocks();
  route = await import("../../app/api/account/export/route");
});

const createRequest = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost:3000/api/account/export", {
    method: "GET",
    headers: { Authorization: "Bearer HCT:test", ...headers },
  });

describe("GET /api/account/export proxy", () => {
  it("sanitizes backend error messages to prevent leakage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("raw database failure with table names", { status: 500 })
    );

    const response = await route.GET(createRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "Failed to export account data" });
    // Ensure no raw backend headers are leaked
    expect(response.headers.get("x-backend-error")).toBeNull();
  });

  it("handles malformed JSON payloads from backend with 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const response = await route.GET(createRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Invalid response from backend" });
  });

  it("enforces Authorization propagation for downstream requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: "stream" })
    );

    await route.GET(createRequest({ Authorization: "Bearer secret-key" }));

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-key",
        }),
      })
    );
  });

  it("returns 401 when authorization header is missing", async () => {
    const response = await route.GET(createRequest({ Authorization: "" }));
    expect(response.status).toBe(401);
  });
});