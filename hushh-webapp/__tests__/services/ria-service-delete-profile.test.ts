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

describe("RiaService.deleteProfile", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("POSTs to the delete endpoint with the id token and returns the result", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ deleted: true, remaining_personas: ["investor"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.deleteProfile("id-token");

    expect(result.deleted).toBe(true);
    expect(result.remaining_personas).toEqual(["investor"]);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/profile/delete",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer id-token",
        }),
      }),
    );
  });

  it("throws when the backend returns an error status", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "RIA profile not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    await expect(RiaService.deleteProfile("id-token")).rejects.toBeTruthy();
  });
});

describe("RiaService.getPersonaState force bypass", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("forwards force to the persona route so the server bypasses its 30s cache", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: "u1",
          personas: ["investor"],
          last_active_persona: "investor",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { RiaService } = await import("@/lib/services/ria-service");
    await RiaService.getPersonaState("tok", { userId: "u-force", force: true });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/iam/persona?force=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("omits force on a normal read", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: "u2",
          personas: ["investor"],
          last_active_persona: "investor",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { RiaService } = await import("@/lib/services/ria-service");
    await RiaService.getPersonaState("tok", { userId: "u-normal" });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/iam/persona",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
