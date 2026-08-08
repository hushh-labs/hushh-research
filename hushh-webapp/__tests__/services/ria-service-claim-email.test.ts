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

describe("RiaService claim email verification methods", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("posts the work email to claim/email/start and returns the masked receipt", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ status: "sent", email_masked: "r•••@examplefirm.com" }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimEmailStart("id-token", {
      email: "reggie@examplefirm.com",
    });

    expect(result.status).toBe("sent");
    expect(result.email_masked).toBe("r•••@examplefirm.com");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/claim/email/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "reggie@examplefirm.com" }),
        headers: expect.objectContaining({
          Authorization: "Bearer id-token",
        }),
      }),
    );
  });

  it("returns send_failed as a result on 502 so the UI can offer Retry", async () => {
    // Best-effort mail: the alias ceremony stood, only the send failed.
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        { status: "send_failed", email_masked: "r•••@examplefirm.com" },
        502,
      ),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimEmailStart("id-token", {
      email: "reggie@examplefirm.com",
    });

    expect(result.status).toBe("send_failed");
  });

  it("surfaces the typed domain-mismatch rejection", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "EMAIL_DOMAIN_MISMATCH",
            message: "Use an email at your firm's domain.",
          },
        },
        409,
      ),
    );

    const { RiaService, RiaApiError } = await import(
      "@/lib/services/ria-service"
    );
    const err = await RiaService.claimEmailStart("id-token", {
      email: "reggie@gmail.com",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RiaApiError);
    expect(err.code).toBe("EMAIL_DOMAIN_MISMATCH");
    expect(err.message).toBe("Use an email at your firm's domain.");
  });

  it("confirms the code and returns the upgraded status", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        verified: true,
        verification_status: "verified",
        verification_level: "verified",
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimEmailConfirm("id-token", {
      email: "reggie@examplefirm.com",
      code: "123456",
    });

    expect(result.verified).toBe(true);
    expect(result.verification_status).toBe("verified");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/claim/email/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "reggie@examplefirm.com",
          code: "123456",
        }),
      }),
    );
  });

  it("returns verified:false untouched when the evaluator declines", async () => {
    // Non-verified evaluator answer is a 200 with no local status write.
    apiFetchMock.mockResolvedValue(
      jsonResponse({ verified: false, verification_status: "submitted" }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimEmailConfirm("id-token", {
      email: "reggie@examplefirm.com",
      code: "123456",
    });

    expect(result.verified).toBe(false);
    expect(result.verification_status).toBe("submitted");
  });

  it("surfaces the typed wrong-code rejection", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "EMAIL_ALIAS_CODE_INVALID",
            message: "That code didn't work.",
          },
        },
        400,
      ),
    );

    const { RiaService, RiaApiError } = await import(
      "@/lib/services/ria-service"
    );
    const err = await RiaService.claimEmailConfirm("id-token", {
      email: "reggie@examplefirm.com",
      code: "000000",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RiaApiError);
    expect(err.code).toBe("EMAIL_ALIAS_CODE_INVALID");
  });
});
