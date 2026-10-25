import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.example",
}));

import { GET, POST } from "@/app/api/one/[...path]/route";

describe("One API proxy cache policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards business completion receipts and owner auth without caching", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ saved: true }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({ commits: [{ domain: "professional", plan_id: "plan_1" }] });
    const response = await POST(new NextRequest("http://localhost/api/one/business/suggestion/complete", {
      method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" }, body,
    }), { params: Promise.resolve({ path: ["business", "suggestion", "complete"] }) });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://backend.example/api/one/business/suggestion/complete");
    const forwarded = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(forwarded.headers).get("authorization")).toBe("Bearer owner-token");
    expect(forwarded.body).toBe(body);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ saved: true });
  });

  it("keeps the authenticated Financial summary uncached on both proxy hops", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ packets: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new NextRequest("http://localhost/api/one/people/person-ref/financial-packets?cursor=next", {
      headers: { Authorization: "Bearer firebase-token" },
    }), { params: Promise.resolve({ path: ["people", "person-ref", "financial-packets"] }) });
    expect(fetchMock).toHaveBeenCalledWith("https://backend.example/api/one/people/person-ref/financial-packets?cursor=next", expect.objectContaining({ cache: "no-store" }));
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer firebase-token");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
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
