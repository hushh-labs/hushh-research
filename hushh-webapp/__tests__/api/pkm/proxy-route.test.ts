import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type PkmRouteModule = {
  GET: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
};

function createRequest(url: string, init: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

async function loadRoute(): Promise<PkmRouteModule> {
  return import("../../../app/api/pkm/[...path]/route");
}

describe("/api/pkm/[...path] proxy trace propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards request id upstream and preserves backend trace headers on fresh and cached PKM metadata responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: "user-1",
          domains: [],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-correlation-id": "corr-pkm-1",
            "x-cloud-trace-context": "trace-pkm-1/123;o=1",
          },
        }
      )
    );
    const route = await loadRoute();

    const first = await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer vault-owner-token",
          "x-request-id": "req_pkm_trace_1",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );
    const second = await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer vault-owner-token",
          "x-request-id": "req_pkm_trace_2",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] ?? [];
    const upstreamHeaders = options?.headers as Headers;
    expect(upstreamHeaders.get("x-request-id")).toBe("req_pkm_trace_1");
    expect(upstreamHeaders.get("Authorization")).toBe("Bearer vault-owner-token");

    expect(first.headers.get("x-request-id")).toBe("req_pkm_trace_1");
    expect(first.headers.get("x-correlation-id")).toBe("corr-pkm-1");
    expect(first.headers.get("x-cloud-trace-context")).toBe("trace-pkm-1/123;o=1");

    expect(second.headers.get("x-request-id")).toBe("req_pkm_trace_2");
    expect(second.headers.get("x-correlation-id")).toBe("corr-pkm-1");
    expect(second.headers.get("x-cloud-trace-context")).toBe("trace-pkm-1/123;o=1");
    await expect(second.json()).resolves.toEqual({
      user_id: "user-1",
      domains: [],
    });
  });

  it("preserves cached PKM trace headers when a later metadata refresh falls back to stale cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user_id: "user-1", domains: [{ key: "financial" }] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-correlation-id": "corr-stale-source",
            "x-trace-id": "trace-stale-source",
          },
        })
      )
      .mockRejectedValueOnce(new Error("backend unavailable"));
    const route = await loadRoute();

    await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer stale-token-a",
          "x-request-id": "req_stale_seed",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );

    vi.setSystemTime(new Date("2026-05-14T00:06:00.000Z"));

    const stale = await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer stale-token-a",
          "x-request-id": "req_stale_fallback",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-request-id")).toBe("req_stale_fallback");
    expect(stale.headers.get("x-correlation-id")).toBe("corr-stale-source");
    expect(stale.headers.get("x-cloud-trace-context")).toBe("trace-stale-source");
  });

  it("does not reuse cached PKM metadata or trace headers across vault owner tokens", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user_id: "user-1", domains: [{ key: "financial" }] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-correlation-id": "corr-token-a",
            "x-cloud-trace-context": "trace-token-a/123;o=1",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user_id: "user-1", domains: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-correlation-id": "corr-token-b",
            "x-cloud-trace-context": "trace-token-b/456;o=1",
          },
        })
      );
    const route = await loadRoute();

    await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer vault-owner-token-a",
          "x-request-id": "req_token_a",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );

    const second = await route.GET(
      createRequest("http://localhost:3000/api/pkm/metadata/user-1", {
        method: "GET",
        headers: {
          Authorization: "Bearer vault-owner-token-b",
          "x-request-id": "req_token_b",
        },
      }),
      { params: Promise.resolve({ path: ["metadata", "user-1"] }) }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(second.headers.get("x-correlation-id")).toBe("corr-token-b");
    expect(second.headers.get("x-cloud-trace-context")).toBe("trace-token-b/456;o=1");
    await expect(second.json()).resolves.toEqual({ user_id: "user-1", domains: [] });
  });
});
