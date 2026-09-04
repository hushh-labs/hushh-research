import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.example",
}));

import { POST } from "@/app/api/one/[...path]/route";

describe("One API proxy cache policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enforces private no-store even when an upstream response is cacheable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ suggestions: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            Pragma: "cache",
            "Retry-After": "12",
          },
        }),
      ),
    );

    const response = await POST(
      new NextRequest(
        "http://localhost/api/one/location/maps/nearby-places",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer owner-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lat: 12.9716,
            lng: 77.5946,
            category: "all",
          }),
        },
      ),
      { params: Promise.resolve({ path: ["location", "maps", "nearby-places"] }) },
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("retry-after")).toBe("12");
  });
});
