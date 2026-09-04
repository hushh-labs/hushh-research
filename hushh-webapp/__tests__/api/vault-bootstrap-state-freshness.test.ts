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

vi.mock("@/lib/auth/validate", () => ({
  validateFirebaseToken: vi.fn(async () => ({ valid: true })),
}));

vi.mock("@/lib/config", () => ({
  isDevelopment: () => false,
}));

vi.mock("@/lib/utils/request-timeouts", () => ({
  resolveSlowRequestTimeoutMs: () => 1_000,
  isRequestTimeoutError: (error: unknown) =>
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError"),
}));

type BootstrapRoute = {
  POST: (request: NextRequest) => Promise<Response>;
};

let route: BootstrapRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  route = await import("../../app/api/vault/bootstrap-state/route");
});

function request(): NextRequest {
  return new NextRequest("http://localhost:3000/api/vault/bootstrap-state", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "user-1" }),
  });
}

describe("/api/vault/bootstrap-state freshness", () => {
  it("never reuses a process-local bootstrap response after setup state changes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ setupCompleted: false, onboardingPhase: "setup_hub" }),
      )
      .mockResolvedValueOnce(
        Response.json({ setupCompleted: true, onboardingPhase: "root_completion" }),
      );

    const first = await route.POST(request());
    const second = await route.POST(request());

    await expect(first.json()).resolves.toMatchObject({ setupCompleted: false });
    await expect(second.json()).resolves.toMatchObject({ setupCompleted: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a Node timeout once without serving stale setup state", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(
        Response.json({ setupCompleted: true, onboardingPhase: "root_completion" }),
      );

    const response = await route.POST(request());

    await expect(response.json()).resolves.toMatchObject({
      setupCompleted: true,
      onboardingPhase: "root_completion",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
