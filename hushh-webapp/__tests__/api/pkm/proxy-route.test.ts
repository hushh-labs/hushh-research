import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type PkmRouteModule = {
  GET: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  POST: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
};

let pkmRoute: PkmRouteModule;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  pkmRoute = await import("../../../app/api/pkm/[...path]/route");
});

function createRequest(
  url: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    cacheControl?: string;
  } = {},
): NextRequest {
  return new NextRequest(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: "Bearer vault_owner_token",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.cacheControl ? { "Cache-Control": options.cacheControl } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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

  it("invalidates a cached empty metadata response after a PKM write", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "No PKM data found for user" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          user_id: "user-1",
          domains: [{ key: "professional" }],
          total_attributes: 1,
          model_completeness: 20,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const metadataPath = { params: Promise.resolve({ path: ["metadata", "user-1"] }) };
    await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      metadataPath,
    );
    await pkmRoute.POST(
      createRequest("http://localhost:3000/api/pkm/store-domain", {
        method: "POST",
        body: { user_id: "user-1" },
      }),
      { params: Promise.resolve({ path: ["store-domain"] }) },
    );
    const refreshed = await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      metadataPath,
    );

    await expect(refreshed.json()).resolves.toMatchObject({
      domains: [{ key: "professional" }],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not let a pre-write metadata request restore stale empty state", async () => {
    let resolveStaleMetadata!: (response: Response) => void;
    const staleMetadata = new Promise<Response>((resolve) => {
      resolveStaleMetadata = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(staleMetadata)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          user_id: "user-1",
          domains: [{ key: "professional" }],
          total_attributes: 1,
          model_completeness: 20,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const metadataPath = { params: Promise.resolve({ path: ["metadata", "user-1"] }) };

    const preWriteMetadata = pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      metadataPath,
    );
    await Promise.resolve();
    await pkmRoute.POST(
      createRequest("http://localhost:3000/api/pkm/store-domain", {
        method: "POST",
        body: { user_id: "user-1" },
      }),
      { params: Promise.resolve({ path: ["store-domain"] }) },
    );
    resolveStaleMetadata(
      new Response(JSON.stringify({ detail: "No PKM data found for user" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await preWriteMetadata;

    const refreshed = await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      metadataPath,
    );

    await expect(refreshed.json()).resolves.toMatchObject({
      domains: [{ key: "professional" }],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("bypasses process-local metadata cache for an explicit refresh", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "No PKM data found for user" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          user_id: "user-1",
          domains: [{ key: "professional" }],
          total_attributes: 1,
          model_completeness: 20,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const metadataPath = { params: Promise.resolve({ path: ["metadata", "user-1"] }) };

    await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1"),
      metadataPath,
    );
    const refreshed = await pkmRoute.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        cacheControl: "no-cache",
      }),
      metadataPath,
    );

    await expect(refreshed.json()).resolves.toMatchObject({
      domains: [{ key: "professional" }],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
