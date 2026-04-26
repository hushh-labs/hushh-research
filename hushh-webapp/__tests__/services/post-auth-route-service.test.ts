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
    }) => Boolean(state?.preOnboardingCompletedAt || state?.preOnboardingCompleted),
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

import { buildPhoneMandateRoute, ROUTES } from "@/lib/navigation/routes";
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
    ).resolves.toBe(ROUTES.KAI_ONBOARDING);
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
        redirectPath: ROUTES.KAI_ONBOARDING,
      })
    ).resolves.toBe(ROUTES.KAI_HOME);
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
    });
    updatePreVaultStateMock.mockResolvedValue({});

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      })
    ).resolves.toBe(ROUTES.KAI_HOME);
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
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.KAI_ONBOARDING));
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
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.KAI_HOME));
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
    ).resolves.toBe(ROUTES.KAI_HOME);
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
    ).resolves.toBe(ROUTES.KAI_HOME);
  });
});
