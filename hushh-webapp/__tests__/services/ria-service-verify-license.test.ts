import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/services/ria-onboarding-status-local-service", () => ({
  RiaOnboardingStatusLocalService: {
    load: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {},
  PkmScopeExposureError: class PkmScopeExposureError extends Error {},
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {},
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
  toEventResult: vi.fn((value) => value),
  toStatusBucket: vi.fn((value) => value),
}));

vi.mock("@/lib/observability/growth", () => ({
  resolveGrowthWorkspaceSource: vi.fn(() => "test"),
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

function foundResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "found",
      advisor_name: "Andrew Kirkland",
      provider: "test",
      cache_ttl_seconds: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("RiaService.verifyOnboardingLicense client cache", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("serves a fresh cached 'found' result without a second network call", async () => {
    apiFetchMock.mockResolvedValue(foundResponse());
    const { RiaService } = await import("@/lib/services/ria-service");

    const first = await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1" },
    );
    const second = await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1" },
    );

    expect(first.status).toBe("found");
    expect(second.status).toBe("found");
    // Second call is a cache hit → the endpoint is only hit once.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when force is true (explicit re-verify)", async () => {
    apiFetchMock.mockResolvedValue(foundResponse());
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1" },
    );
    await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1", force: true },
    );

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache an error result", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: "error", provider: "test" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1" },
    );
    await RiaService.verifyOnboardingLicense(
      "id-token",
      { license_number: "7413463", regulator: "SEC" },
      { userId: "u1" },
    );

    // An error is never cached → the second call re-hits the endpoint.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not read cache when no userId is provided", async () => {
    apiFetchMock.mockResolvedValue(foundResponse());
    const { RiaService } = await import("@/lib/services/ria-service");

    await RiaService.verifyOnboardingLicense("id-token", {
      license_number: "7413463",
      regulator: "SEC",
    });
    await RiaService.verifyOnboardingLicense("id-token", {
      license_number: "7413463",
      regulator: "SEC",
    });

    // No cache key without a userId → both calls hit the endpoint.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
