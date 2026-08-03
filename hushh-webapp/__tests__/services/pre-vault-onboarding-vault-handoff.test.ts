import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const removeMock = vi.fn();
const removeLocalItemMock = vi.fn();
const secureReadMock = vi.fn();
const secureWriteRequiredMock = vi.fn();
const secureInvalidateMock = vi.fn();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (...args: unknown[]) => getMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
    set: vi.fn(),
  },
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: vi.fn(),
  setLocalItem: vi.fn(),
  removeLocalItem: (...args: unknown[]) => removeLocalItemMock(...args),
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingRequiredCookie: vi.fn(),
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    writeRequired: (...args: unknown[]) => secureWriteRequiredMock(...args),
    invalidateResource: (...args: unknown[]) => secureInvalidateMock(...args),
  },
}));

import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";

const USER_ID = "uid-handoff";
const VAULT_KEY = "ab".repeat(32);
const state = {
  version: 1 as const,
  completed: true,
  skipped: false,
  completed_at: "2026-07-30T00:00:00.000Z",
  answers: {
    investment_horizon: "long_term" as const,
    drawdown_response: "stay" as const,
    volatility_preference: "moderate" as const,
  },
  risk_score: 3,
  risk_profile: "balanced" as const,
  synced_to_vault_at: null,
  updated_at: "2026-07-30T00:00:00.000Z",
};

describe("PreVaultOnboardingService vault handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue(undefined);
    secureWriteRequiredMock.mockResolvedValue(undefined);
    secureInvalidateMock.mockResolvedValue(undefined);
    secureReadMock.mockResolvedValue(null);
  });

  it("seals the handoff before removing the plaintext origin", async () => {
    await PreVaultOnboardingService.completeAfterVaultCommit({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      state,
    });

    expect(secureWriteRequiredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        vaultKey: VAULT_KEY,
        resourceKey: "pre_vault_onboarding:vault_handoff:v1",
        value: expect.objectContaining({
          source: "pre_vault_onboarding",
          committedAt: expect.any(String),
        }),
      }),
    );
    expect(removeMock).toHaveBeenCalledWith({
      key: "kai_pre_vault_onboarding_v1:uid-handoff",
    });
    expect(removeLocalItemMock).toHaveBeenCalledWith(
      "kai_pre_vault_onboarding_v1:fallback:uid-handoff",
    );
    expect(
      secureWriteRequiredMock.mock.invocationCallOrder[0],
    ).toBeLessThan(removeMock.mock.invocationCallOrder[0]);
  });

  it("retains the origin when encrypted handoff persistence fails", async () => {
    secureWriteRequiredMock.mockRejectedValueOnce(new Error("secure_cache_unavailable"));

    await expect(
      PreVaultOnboardingService.completeAfterVaultCommit({
        userId: USER_ID,
        vaultKey: VAULT_KEY,
        state,
      }),
    ).rejects.toThrow("secure_cache_unavailable");

    expect(removeMock).not.toHaveBeenCalled();
    expect(removeLocalItemMock).not.toHaveBeenCalled();
  });

  it("keeps the encrypted receipt and source when origin cleanup is interrupted", async () => {
    removeMock.mockRejectedValueOnce(new Error("preferences_remove_failed"));

    await expect(
      PreVaultOnboardingService.completeAfterVaultCommit({
        userId: USER_ID,
        vaultKey: VAULT_KEY,
        state,
      }),
    ).rejects.toThrow("preferences_remove_failed");

    expect(secureWriteRequiredMock).toHaveBeenCalledOnce();
    expect(secureInvalidateMock).not.toHaveBeenCalled();
    expect(removeLocalItemMock).not.toHaveBeenCalled();
  });

  it("retries only source cleanup when an encrypted commit receipt already exists", async () => {
    secureReadMock.mockResolvedValueOnce({
      version: 1,
      source: "pre_vault_onboarding",
      state,
      committedAt: "2026-07-30T00:00:01.000Z",
    });

    await expect(
      PreVaultOnboardingService.finalizeKnownVaultCommit({
        userId: USER_ID,
        vaultKey: VAULT_KEY,
      }),
    ).resolves.toBe(true);

    expect(secureWriteRequiredMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledOnce();
    expect(secureInvalidateMock).toHaveBeenCalledWith(
      USER_ID,
      "pre_vault_onboarding:vault_handoff:v1",
    );
  });
});
