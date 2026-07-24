import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiJsonMock, getIdTokenMock, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly payload?: unknown
    ) {
      super(message);
      this.name = "ApiError";
    }
  }

  return {
    apiJsonMock: vi.fn(),
    getIdTokenMock: vi.fn(),
    MockApiError,
  };
});

vi.mock("@/lib/services/api-client", () => ({
  ApiError: MockApiError,
  apiJson: (...args: unknown[]) => apiJsonMock(...args),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: (...args: unknown[]) => getIdTokenMock(...args),
  },
}));

import { CacheService } from "@/lib/services/cache-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

describe("PreVaultUserStateService bootstrap retries", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    getIdTokenMock.mockResolvedValue("firebase-token");
  });

  it("retries retryable bootstrap failures and preserves the normalized response shape", async () => {
    vi.useFakeTimers();
    apiJsonMock
      .mockRejectedValueOnce(new MockApiError("service unavailable", 503))
      .mockResolvedValueOnce({
        userId: "user-1",
        hasVault: true,
        vaultStatus: "active",
        firstLoginAt: "1710000000000",
        lastLoginAt: 1710000010000,
        loginCount: 3,
        preOnboardingCompleted: "true",
      });

    const resultPromise = PreVaultUserStateService.bootstrapState("user-1", { force: true });
    await vi.advanceTimersByTimeAsync(200);

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        userId: "user-1",
        hasVault: true,
        vaultStatus: "active",
        firstLoginAt: 1710000000000,
        lastLoginAt: 1710000010000,
        loginCount: 3,
        preOnboardingCompleted: true,
      })
    );
    expect(apiJsonMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable bootstrap failures", async () => {
    apiJsonMock.mockRejectedValueOnce(new MockApiError("bad request", 400));

    await expect(
      PreVaultUserStateService.bootstrapState("user-1", { force: true })
    ).rejects.toThrow("bad request");

    expect(apiJsonMock).toHaveBeenCalledTimes(1);
  });
});
