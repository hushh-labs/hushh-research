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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DOSSIER_ROW = {
  status: "sent",
  summary: "One-paragraph synthesis.",
  markdown: "# Dossier\n\nBuilt from your SEC record.",
  requested_at: "2026-08-08T00:00:00Z",
  completed_at: "2026-08-08T00:20:00Z",
  mail: { status: "sent", recipient_masked: "r•••@examplefirm.com" },
};

describe("RiaService dossier methods", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("reads the own-row dossier from GET /api/ria/dossier with the bearer token", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(DOSSIER_ROW));

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.getDossier("id-token");

    expect(result).not.toBeNull();
    expect(result?.status).toBe("sent");
    expect(result?.markdown).toContain("Built from your SEC record.");
    expect(result?.mail?.recipient_masked).toBe("r•••@examplefirm.com");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/dossier",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer id-token",
        }),
      }),
    );
  });

  it("returns null on 404 — never-dispatched is a normal state, not an error", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ detail: "No dossier for this profile." }, 404),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.getDossier("id-token");

    expect(result).toBeNull();
  });

  it("throws a typed RiaApiError on non-404 read failures", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ detail: "Internal error." }, 500),
    );

    const { RiaService, RiaApiError } = await import(
      "@/lib/services/ria-service"
    );
    const err = await RiaService.getDossier("id-token").catch((e) => e);

    expect(err).toBeInstanceOf(RiaApiError);
    expect(err.status).toBe(500);
  });

  it("posts to /api/ria/dossier/retry and returns the re-queued row", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ ...DOSSIER_ROW, status: "queued", completed_at: null }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.retryDossier("id-token");

    expect(result.status).toBe("queued");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/dossier/retry",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer id-token",
        }),
      }),
    );
  });

  it("surfaces the typed rejection when a retry is not allowed from the current status", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "DOSSIER_NOT_RETRYABLE",
            message: "The dossier is not in a failed state.",
          },
        },
        409,
      ),
    );

    const { RiaService, RiaApiError } = await import(
      "@/lib/services/ria-service"
    );
    const err = await RiaService.retryDossier("id-token").catch((e) => e);

    expect(err).toBeInstanceOf(RiaApiError);
    expect(err.code).toBe("DOSSIER_NOT_RETRYABLE");
  });
});
