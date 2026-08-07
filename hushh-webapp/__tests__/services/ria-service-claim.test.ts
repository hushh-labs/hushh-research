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

describe("RiaService claim-by-phone methods", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset();
  });

  it("posts the phone to claim/lookup and returns the shaped outcome", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        outcome: "single_person",
        next_step: "choose_identity",
        firm: { crd: 283040, name: "OLYMPUS PEAKS FINANCIAL, LLC" },
        firms: [],
        candidates: [{ individual_crd: 5308823, name: "REGINALD TROY MAXFIELD" }],
        current_adviser_count: 1,
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimLookup("id-token", {
      phone: "8015663510",
    });

    expect(result.outcome).toBe("single_person");
    expect(result.firm?.crd).toBe(283040);
    expect(result.candidates[0].individual_crd).toBe(5308823);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/claim/lookup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ phone: "8015663510" }),
        headers: expect.objectContaining({
          Authorization: "Bearer id-token",
        }),
      }),
    );
  });

  it("starts the claim OTP and surfaces the test-code challenge", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        eligible: true,
        delivery: "test_code",
        verification_id: "ria-claim-test:abc",
        code_length: 5,
        phone_masked: "••• ••• 3510",
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimOtpStart("id-token", {
      phone: "8015663510",
    });

    expect(result.eligible).toBe(true);
    expect(result.code_length).toBe(5);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/claim/otp/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("verifies possession and returns the unlocked roster with a ticket", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        claim_ticket: "ria-claim-ticket.v1:123:abc",
        provisional: true,
        profile_verified: true,
        verification_level: "verified",
        roster_unlocked: true,
        roster: [{ individual_crd: 5308823, name: "REGINALD TROY MAXFIELD" }],
        proof_channel: "test_code",
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimVerify("id-token", {
      phone: "8015663510",
      claim_type: "individual",
      firm_crd: 283040,
      verification_id: "ria-claim-test:abc",
      verification_code: "00000",
    });

    expect(result.roster_unlocked).toBe(true);
    expect(result.claim_ticket).toContain("ria-claim-ticket");
    expect(result.roster?.[0].individual_crd).toBe(5308823);
  });

  it("surfaces the backend's object-detail message and code on a rejected code", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "CLAIM_INVALID_CODE",
            message: "That code didn't work. Check it and try again.",
          },
        },
        401,
      ),
    );

    const { RiaService, RiaApiError } = await import("@/lib/services/ria-service");
    const err = await RiaService.claimVerify("id-token", {
      phone: "8015663510",
      claim_type: "individual",
      firm_crd: 283040,
      verification_id: "ria-claim-test:abc",
      verification_code: "11111",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RiaApiError);
    // The typed {code, message} detail must reach the UI, not "Request failed: 401".
    expect(err.message).toBe("That code didn't work. Check it and try again.");
    expect(err.code).toBe("CLAIM_INVALID_CODE");
  });

  it("completes the claim and returns the auto-built profile", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        status: "claimed",
        claim_type: "individual",
        verification_level: "verified",
        profile_verified: true,
        provisional: true,
        profile: {
          ria_profile_id: "profile-1",
          user_id: "user-1",
          display_name: "Reginald Troy Maxfield",
          verification_status: "verified",
          firm_name: "OLYMPUS PEAKS FINANCIAL, LLC",
        },
      }),
    );

    const { RiaService } = await import("@/lib/services/ria-service");
    const result = await RiaService.claimComplete("id-token", {
      phone: "8015663510",
      claim_ticket: "ria-claim-ticket.v1:123:abc",
      claim_type: "individual",
      firm_crd: 283040,
      individual_crd: 5308823,
    });

    expect(result.status).toBe("claimed");
    expect(result.profile.display_name).toBe("Reginald Troy Maxfield");
    expect(result.profile.verification_status).toBe("verified");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/ria/claim/complete",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
