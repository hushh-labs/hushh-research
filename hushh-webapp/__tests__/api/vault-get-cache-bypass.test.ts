import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

vi.mock("@/app/api/_utils/request-id", () => ({
  createUpstreamHeaders: (_requestId: string, headers: HeadersInit) => headers,
  resolveRequestId: () => "request-id",
  withRequestIdJson: (
    _requestId: string,
    payload: unknown,
    init?: ResponseInit,
  ) => Response.json(payload, init),
}));

vi.mock("@/lib/config", () => ({
  isDevelopment: () => false,
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/utils/request-timeouts", () => ({
  resolveSlowRequestTimeoutMs: (timeoutMs: number) => timeoutMs,
  isRequestTimeoutError: () => false,
}));

type VaultGetRoute = {
  GET: (request: NextRequest) => Promise<Response>;
};

let route: VaultGetRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  route = await import("../../app/api/vault/get/route");
});

function request(query: string, authHeader = "Bearer test-token") {
  return new NextRequest(`http://localhost:3000/api/vault/get?${query}`, {
    headers: { Authorization: authHeader },
  });
}

describe("GET /api/vault/get cache bypass for a forced (unlock) read", () => {
  it("serves a warm cache on an ordinary read", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ primaryMethod: "passphrase", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-1"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the warm cache and hits the backend again when fresh=1 is set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }))
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const freshResponse = await route.GET(request("userId=user-1&fresh=1"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(freshResponse.json()).resolves.toMatchObject({ primaryMethod: "passphrase" });
  });

  it("writes a fresh entry back into the cache so later ordinary reads see it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }))
      .mockResolvedValueOnce(Response.json({ primaryMethod: "generated_default_native_biometric", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-1&fresh=1"));
    const cached = await route.GET(request("userId=user-1"));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(cached.json()).resolves.toMatchObject({
      primaryMethod: "generated_default_native_biometric",
    });
  });
});
