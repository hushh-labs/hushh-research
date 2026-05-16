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

  it("returns a stable error for invalid backend success payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

    const response = await route.GET(request({ Authorization: "Bearer HCT:test" }));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({ error: "Invalid response from backend" });
  });
});
