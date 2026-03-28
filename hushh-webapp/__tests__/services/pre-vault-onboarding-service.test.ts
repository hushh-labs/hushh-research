import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();

const getLocalItemMock = vi.fn();
const setLocalItemMock = vi.fn();
const removeLocalItemMock = vi.fn();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: (...args: unknown[]) => getLocalItemMock(...args),
  setLocalItem: (...args: unknown[]) => setLocalItemMock(...args),
  removeLocalItem: (...args: unknown[]) => removeLocalItemMock(...args),
}));

import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";

describe("PreVaultOnboardingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.cookie = "";
  });

  it("falls back to local storage when Preferences.set fails during saveDraft", async () => {
    getMock.mockResolvedValueOnce({ value: null });
    setMock.mockRejectedValueOnce(new Error("preferences_unavailable"));

    const state = await PreVaultOnboardingService.saveDraft("uid-1", {
      answers: {
        investment_horizon: "long_term",
      },
      risk_score: 5,
      risk_profile: "aggressive",
    });

    expect(state.answers.investment_horizon).toBe("long_term");
    expect(state.risk_score).toBe(5);
    expect(state.risk_profile).toBe("aggressive");
    expect(setLocalItemMock).toHaveBeenCalledWith(
      "kai_pre_vault_onboarding_v1:fallback:uid-1",
      expect.stringContaining("\"investment_horizon\":\"long_term\"")
    );
  });

  it("loads fallback state when Preferences.get fails", async () => {
    getMock.mockRejectedValueOnce(new Error("preferences_read_failed"));
    getLocalItemMock.mockReturnValueOnce(
      JSON.stringify({
        version: 1,
        completed: false,
        skipped: false,
        completed_at: null,
        answers: {
          investment_horizon: "medium_term",
          drawdown_response: "stay",
          volatility_preference: "moderate",
        },
        risk_score: 3,
        risk_profile: "balanced",
        synced_to_vault_at: null,
        updated_at: "2026-03-28T00:00:00.000Z",
      })
    );

    const state = await PreVaultOnboardingService.load("uid-1");

    expect(state).toEqual(
      expect.objectContaining({
        completed: false,
        risk_score: 3,
        risk_profile: "balanced",
        answers: expect.objectContaining({
          investment_horizon: "medium_term",
          drawdown_response: "stay",
          volatility_preference: "moderate",
        }),
      })
    );
  });

  it("clears fallback storage even when Preferences.remove fails", async () => {
    removeMock.mockRejectedValueOnce(new Error("preferences_remove_failed"));

    await PreVaultOnboardingService.clear("uid-1");

    expect(removeLocalItemMock).toHaveBeenCalledWith("kai_pre_vault_onboarding_v1:fallback:uid-1");
  });
});
