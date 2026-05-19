import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type PkmRouteModule = {
  GET: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
};

let pkmRoute: PkmRouteModule;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  pkmRoute = await import("../../../app/api/pkm/[...path]/route");
});

function createRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer vault_owner_token",
    },
  });
}

describe("/api/pkm/[...path] proxy", () => {
  it("normalizes missing metadata to an empty bootstrap payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "No PKM data found for user" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hushh-empty-state")).toBe("pkm-metadata");
    expect(payload).toMatchObject({
      user_id: "user-1",
      domains: [],
      total_attributes: 0,
      upgrade_status: "current",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://backend.test/api/pkm/metadata/user-1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("normalizes missing domain data to a null encrypted blob", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "No ria data found for user" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/domain-data/user-1/ria"),
      { params: Promise.resolve({ path: ["domain-data", "user-1", "ria"] }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hushh-empty-state")).toBe("pkm-domain-data");
    expect(payload).toEqual({
      encrypted_blob: null,
      storage_mode: "domain",
      data_version: null,
      updated_at: null,
      manifest_revision: null,
      segment_ids: [],
    });
  });
});
