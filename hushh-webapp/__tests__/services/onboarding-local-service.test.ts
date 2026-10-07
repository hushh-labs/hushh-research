import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPreferences, mockGetLocalItem, mockSetLocalItem, mockRemoveLocalItem } = vi.hoisted(
  () => ({
    mockPreferences: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn(),
    },
    mockGetLocalItem: vi.fn(),
    mockSetLocalItem: vi.fn(),
    mockRemoveLocalItem: vi.fn(),
  })
);

vi.mock("@capacitor/preferences", () => ({
  Preferences: mockPreferences,
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: mockGetLocalItem,
  setLocalItem: mockSetLocalItem,
  removeLocalItem: mockRemoveLocalItem,
}));

import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";

describe("OnboardingLocalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.remove.mockResolvedValue(undefined);
  });

  describe("hasSeenMarketing", () => {
    it("returns true when the flag is set to 'true'", async () => {
      mockPreferences.get.mockResolvedValue({ value: "true" });
      expect(await OnboardingLocalService.hasSeenMarketing()).toBe(true);
    });

    it("returns false when the flag is not set", async () => {
      mockPreferences.get.mockResolvedValue({ value: null });
      expect(await OnboardingLocalService.hasSeenMarketing()).toBe(false);
    });

    it("returns false when the flag is 'false'", async () => {
      mockPreferences.get.mockResolvedValue({ value: "false" });
      expect(await OnboardingLocalService.hasSeenMarketing()).toBe(false);
    });

    it("returns false and warns when Preferences throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockPreferences.get.mockRejectedValue(new Error("Storage error"));

      expect(await OnboardingLocalService.hasSeenMarketing()).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[OnboardingLocalService]"),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });
  });

  describe("markMarketingSeen", () => {
    it("persists the flag to both Preferences and local storage", async () => {
      await OnboardingLocalService.markMarketingSeen();

      expect(mockPreferences.set).toHaveBeenCalledWith({
        key: "onboarding_marketing_seen_v1",
        value: "true",
      });
      expect(mockSetLocalItem).toHaveBeenCalledWith("onboarding_marketing_seen_v1", "true");
    });

    it("does not throw when Preferences fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockPreferences.set.mockRejectedValue(new Error("Write failed"));

      await expect(OnboardingLocalService.markMarketingSeen()).resolves.toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe("clearMarketingSeen", () => {
    it("clears from both Preferences and local storage", async () => {
      await OnboardingLocalService.clearMarketingSeen();

      expect(mockPreferences.set).toHaveBeenCalledWith({
        key: "onboarding_marketing_seen_v1",
        value: "false",
      });
      expect(mockPreferences.remove).toHaveBeenCalledWith({
        key: "onboarding_marketing_seen_v1",
      });
      expect(mockRemoveLocalItem).toHaveBeenCalledWith("onboarding_marketing_seen_v1");
    });
  });

  describe("consumeForceIntroOnce", () => {
    it("returns true and clears when local value is set", async () => {
      mockGetLocalItem.mockReturnValue("true");

      const result = await OnboardingLocalService.consumeForceIntroOnce();

      expect(result).toBe(true);
      expect(mockRemoveLocalItem).toHaveBeenCalledWith("onboarding_force_intro_once_v1");
    });

    it("falls back to Preferences when local value is missing", async () => {
      mockGetLocalItem.mockReturnValue(null);
      mockPreferences.get.mockResolvedValue({ value: "true" });

      const result = await OnboardingLocalService.consumeForceIntroOnce();

      expect(result).toBe(true);
      expect(mockPreferences.remove).toHaveBeenCalledWith({
        key: "onboarding_force_intro_once_v1",
      });
    });

    it("returns false when neither local nor Preferences has the flag", async () => {
      mockGetLocalItem.mockReturnValue(null);
      mockPreferences.get.mockResolvedValue({ value: null });

      const result = await OnboardingLocalService.consumeForceIntroOnce();

      expect(result).toBe(false);
    });

    it("returns false when Preferences throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockGetLocalItem.mockReturnValue(null);
      mockPreferences.get.mockRejectedValue(new Error("Read error"));

      const result = await OnboardingLocalService.consumeForceIntroOnce();

      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe("markForceIntroOnce", () => {
    it("persists to both Preferences and local storage", async () => {
      await OnboardingLocalService.markForceIntroOnce();

      expect(mockPreferences.set).toHaveBeenCalledWith({
        key: "onboarding_force_intro_once_v1",
        value: "true",
      });
      expect(mockSetLocalItem).toHaveBeenCalledWith("onboarding_force_intro_once_v1", "true");
    });
  });
});


describe("Wallet introduction preference", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetLocalItem.mockReturnValue(null);
    mockPreferences.get.mockResolvedValue({ value: null });
    mockPreferences.set.mockResolvedValue(undefined);
  });
  it("keeps dismissal scoped to the account", async () => {
    const stored = new Map<string, string>();
    mockPreferences.get.mockImplementation(async ({ key }) => ({ value: stored.get(key) ?? null }));
    mockPreferences.set.mockImplementation(async ({ key, value }) => { stored.set(key, value); });
    expect(await OnboardingLocalService.hasSeenWalletIntroduction("owner-a")).toBe(false);
    await OnboardingLocalService.markWalletIntroductionSeen("owner-a");
    expect(await OnboardingLocalService.hasSeenWalletIntroduction("owner-a")).toBe(true);
    expect(await OnboardingLocalService.hasSeenWalletIntroduction("owner-b")).toBe(false);
  });
  it("uses the browser fallback if native preference writes fail", async () => {
    mockPreferences.set.mockRejectedValue(new Error("Unavailable"));
    await expect(OnboardingLocalService.markWalletIntroductionSeen("owner-a")).resolves.toBeUndefined();
    expect(mockSetLocalItem).toHaveBeenCalledWith("wallet_introduction_seen_v1:owner-a", "true");
    mockGetLocalItem.mockReturnValue("true");
    expect(await OnboardingLocalService.hasSeenWalletIntroduction("owner-a")).toBe(true);
  });
});

describe("Release notice acknowledgement", () => {
  it("persists only cosmetic state for the exact owner and release", async () => {
    const stored = new Map<string, string>();
    mockGetLocalItem.mockImplementation((key) => stored.get(key) ?? null);
    mockSetLocalItem.mockImplementation((key, value) => { stored.set(key, value); });
    mockPreferences.get.mockResolvedValue({ value: null });
    mockPreferences.set.mockRejectedValue(new Error("Native preferences unavailable"));
    await OnboardingLocalService.markReleaseSeen("owner:a", "app:dev:1");
    expect(await OnboardingLocalService.hasSeenRelease("owner:a", "app:dev:1")).toBe(true);
    expect(await OnboardingLocalService.hasSeenRelease("owner:b", "app:dev:1")).toBe(false);
    expect(await OnboardingLocalService.hasSeenRelease("owner:a", "app:production:1")).toBe(false);
    expect([...stored.values()]).toEqual(["true"]);
  });

  it("does not repeat in a session when both persistent stores are unavailable, and erases only the deleted owner", async () => {
    mockGetLocalItem.mockReturnValue(null);
    mockPreferences.get.mockRejectedValue(new Error("Unavailable"));
    mockPreferences.set.mockRejectedValue(new Error("Unavailable"));
    mockPreferences.keys.mockResolvedValue({ keys: ["release_notice_seen_v1:erased-owner:release", "release_notice_seen_v1:kept-owner:release"] });
    await OnboardingLocalService.markReleaseSeen("erased-owner", "release");
    await OnboardingLocalService.markReleaseSeen("kept-owner", "release");
    expect(await OnboardingLocalService.hasSeenRelease("erased-owner", "release")).toBe(true);
    await OnboardingLocalService.clearReleaseNotices("erased-owner");
    expect(await OnboardingLocalService.hasSeenRelease("erased-owner", "release")).toBe(false);
    expect(await OnboardingLocalService.hasSeenRelease("kept-owner", "release")).toBe(true);
    expect(mockPreferences.remove).toHaveBeenCalledWith({ key: "release_notice_seen_v1:erased-owner:release" });
    expect(mockPreferences.remove).not.toHaveBeenCalledWith({ key: "release_notice_seen_v1:kept-owner:release" });
  });
});
