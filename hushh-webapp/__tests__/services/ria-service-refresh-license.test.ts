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

describe("RiaService.refreshLicenseProfile", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("posts the signed-in refresh payload to the profile endpoint", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          updated: true,
          status: "found",
          message: "Official RIA data updated.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.refreshLicenseProfile("id-token", {
      license_number: "7413463",
      regulator: "SEC",
      force_live_verification: true,
    });

    expect(result.updated).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/profile/refresh-license",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer id-token",
        },
        body: JSON.stringify({
          license_number: "7413463",
          regulator: "SEC",
          force_live_verification: true,
        }),
        signal: undefined,
      },
    );
  });
});
