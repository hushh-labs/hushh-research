import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type OneCatchAllRoute = {
  GET: (
    request: NextRequest,
    props: { params: Promise<{ path: string[] }> },
  ) => Promise<Response>;
};

let route: OneCatchAllRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  route = await import("../../app/api/one/[...path]/route");
});

describe("/api/one/[...path] proxy", () => {
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
});
