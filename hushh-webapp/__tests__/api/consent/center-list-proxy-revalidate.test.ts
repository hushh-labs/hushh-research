import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.example",
}));

import { GET } from "@/app/api/consent/center/list/route";

const URL_ACTIVE =
  "http://localhost/api/consent/center/list?mode=consents&surface=active&page=1&limit=20";
const GRANT = { id: "grant_1", kind: "active_grant", scope: "attr.food.*" };

function read(headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(URL_ACTIVE, {
      headers: { Authorization: "Bearer owner-token", ...headers },
    }),
  ).then((response) => response.json());
}

// Regression (localhost 2026-09-28): after Stop sharing, the Consent Center's
// refetch came back in 17ms from this proxy's hot copy of the pre-stop list,
// so the Active tab kept showing the stopped access.
describe("Consent Center list proxy after the person's own change", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a revalidating read from upstream, and later reads get that copy", async () => {
    let upstreamItems: unknown[] = [GRANT];
    const upstream = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: upstreamItems, total: upstreamItems.length }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", upstream);

    expect((await read()).items).toEqual([GRANT]);
    // The owner stops sharing; the backend no longer lists the grant.
    upstreamItems = [];

    // Negative control: an ordinary read still gets the hot pre-stop copy.
    expect((await read()).items).toEqual([GRANT]);
    expect(upstream).toHaveBeenCalledTimes(1);

    // The read right after the change asks to revalidate and reaches upstream.
    expect((await read({ "Cache-Control": "no-cache" })).items).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);

    // It refreshed the hot copy, so the next ordinary read is current too.
    expect((await read()).items).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never answers a revalidating read with the stale copy when upstream fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [GRANT], total: 1 }), { status: 200 }),
        )
        .mockResolvedValue(new Response(JSON.stringify({ detail: "down" }), { status: 503 })),
    );
    // A distinct caller, so the first test's hot entry does not apply.
    const ownerB = { Authorization: "Bearer owner-b" };

    await read(ownerB);
    const response = await GET(
      new NextRequest(URL_ACTIVE, { headers: { ...ownerB, "Cache-Control": "no-cache" } }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("items");
  });
});


it("never caches complete source reads or substitutes presentation cache on failure", async () => {
  const upstream = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [GRANT], source_read_verified: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], source_read_verified: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "unavailable" }), {status: 503}));
  vi.stubGlobal("fetch", upstream);
  const source = () => GET(new NextRequest(URL_ACTIVE + "&source_read=true", {headers:{Authorization:"Bearer source-owner"}}));
  expect((await (await source()).json()).items).toEqual([GRANT]);
  const refreshed = await source();
  expect((await refreshed.json()).items).toEqual([]);
  expect(refreshed.headers.get("Cache-Control")).toContain("no-store");
  expect((await source()).status).toBe(503);
  expect(upstream).toHaveBeenCalledTimes(3);
  expect(upstream.mock.calls.every(([,options]) => options.cache === "no-store")).toBe(true);
  vi.unstubAllGlobals();
});
