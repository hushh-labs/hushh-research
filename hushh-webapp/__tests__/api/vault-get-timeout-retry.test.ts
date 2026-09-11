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
  isRequestTimeoutError: (error: unknown) =>
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError"),
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

describe("GET /api/vault/get timeout recovery", () => {
  it("retries a Node TimeoutError once before reporting vault unavailability", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(
        Response.json({ primaryMethod: "passphrase", wrappers: [] }),
      );

    const response = await route.GET(
      new NextRequest("http://localhost:3000/api/vault/get?userId=user-1", {
        headers: { Authorization: "Bearer test-token" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      primaryMethod: "passphrase",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
