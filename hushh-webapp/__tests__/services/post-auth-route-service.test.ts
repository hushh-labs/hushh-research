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

import { ROUTES } from "@/lib/navigation/routes";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";

describe("PostAuthRouteService", () => {
  beforeEach(() => {
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
      PostAuthRouteService.resolveAfterLogin({ userId: "user_123" })
    ).resolves.toBe(ROUTES.KAI_HOME);
    expect(updatePreVaultStateMock).toHaveBeenCalledTimes(1);
  });

  it("preserves Gmail OAuth callback paths after login", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      preOnboardingCompleted: false,
      preOnboardingCompletedAt: null,
      preOnboardingSkipped: null,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: ROUTES.PROFILE_GMAIL_OAUTH_RETURN,
      })
    ).resolves.toBe(ROUTES.PROFILE_GMAIL_OAUTH_RETURN);
    expect(loadPendingOnboardingMock).not.toHaveBeenCalled();
  });
});
