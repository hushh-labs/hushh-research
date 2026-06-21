import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  bootstrapStateMock,
  updatePreVaultStateMock,
  loadPendingOnboardingMock,
  getPersonaStateMock,
} = vi.hoisted(() => ({
  bootstrapStateMock: vi.fn(),
  updatePreVaultStateMock: vi.fn(),
  loadPendingOnboardingMock: vi.fn(),
  getPersonaStateMock: vi.fn(),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    updatePreVaultState: updatePreVaultStateMock,
    isOnboardingResolved: (state: {
      preOnboardingCompleted?: boolean | null;
      preOnboardingCompletedAt?: number | null;
    }) => state?.preOnboardingCompleted === true,
  },
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: {
    load: loadPendingOnboardingMock,
  },
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: {
    getPersonaState: getPersonaStateMock,
  },
}));

import {
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";

describe("PostAuthRouteService", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    bootstrapStateMock.mockReset();
    updatePreVaultStateMock.mockReset();
    loadPendingOnboardingMock.mockReset();
    getPersonaStateMock.mockReset();
    getPersonaStateMock.mockRejectedValue(new Error("persona not requested"));
  });

  it("routes vault users with unresolved onboarding to onboarding", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      preOnboardingCompleted: false,
      preOnboardingCompletedAt: null,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({ userId: "user_123" })
    ).resolves.toBe(ROUTES.ONE_ONBOARDING);
  });

  it("keeps vault users on the requested route when onboarding is resolved", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: ROUTES.KAI_PORTFOLIO,
      })
    ).resolves.toBe(ROUTES.KAI_PORTFOLIO);
  });

  it("does not send completed vault users back into onboarding from a stale redirect", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: ROUTES.ONE_ONBOARDING,
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
  });

  it("bridges completed pre-vault onboarding before sending no-vault users home", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: null,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: false,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: "long_term",
        drawdown_response: "stay",
        volatility_preference: "moderate",
      },
    });
    updatePreVaultStateMock.mockResolvedValue({});

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
    expect(updatePreVaultStateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted pre-vault onboarding on the setup route after restart", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: null,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: false,
      skipped: false,
      completed_at: null,
      answers: {
        investment_horizon: "long_term",
        drawdown_response: null,
        volatility_preference: null,
      },
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.ONE_ONBOARDING);
    expect(updatePreVaultStateMock).not.toHaveBeenCalled();
  });

  it("does not bridge malformed completed local onboarding without skip or full answers", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: null,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: false,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: "long_term",
        drawdown_response: null,
        volatility_preference: "moderate",
      },
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.ONE_ONBOARDING);
    expect(updatePreVaultStateMock).not.toHaveBeenCalled();
  });

  it("bridges explicit skipped pre-vault onboarding before sending no-vault users home", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: null,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: true,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: null,
        drawdown_response: null,
        volatility_preference: null,
      },
    });
    updatePreVaultStateMock.mockResolvedValue({});

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
    expect(updatePreVaultStateMock).toHaveBeenCalledTimes(1);
  });

  it("routes no-vault users without a verified phone to the phone mandate before onboarding", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: false,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
      })
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.ONE_ONBOARDING));
  });

  it("routes no-vault users without a verified phone to the phone mandate before home", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "",
      })
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.ONE_HOME));
  });

  it("does not route no-vault users with a verified phone through the phone mandate", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
  });

  it("does not route backend phone-verified users back to the phone mandate", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        phoneVerified: true,
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
  });

  it("routes phone-verified no-vault Invite to One users through the shared vault flow", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneVerified: true,
      })
    ).resolves.toBe(buildProfileVaultRoute(inviteRedirect));
  });

  it("keeps the Invite to One token when a no-vault user must verify phone first", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneNumber: null,
        phoneVerified: false,
        hostname: "uat.kai.hushh.ai",
      })
    ).resolves.toBe(buildPhoneMandateRoute(inviteRedirect));
  });

  it("preserves Invite to One return targets that are already inside the profile vault handoff", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";
    const profileVaultRoute = buildProfileVaultRoute(inviteRedirect);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: profileVaultRoute,
        phoneVerified: true,
      })
    ).resolves.toBe(profileVaultRoute);
  });

  it("routes Invite to One redirects through phone verification before claim", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
    });

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneNumber: null,
        phoneVerified: false,
        hostname: "uat.kai.hushh.ai",
      })
    ).resolves.toBe(buildPhoneMandateRoute(inviteRedirect));
  });

  it("skips the phone mandate for localhost development sessions", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        hostname: "localhost",
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
  });
    it("skips the phone mandate for localhost hostname variants in development", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: true,
      preOnboardingCompletedAt: 1,
      preOnboardingSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        hostname: "127.0.0.1",
      })
    ).resolves.toBe(ROUTES.ONE_HOME);
  });
});
