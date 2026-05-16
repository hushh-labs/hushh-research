import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPreferences, mockGetLocalItem, mockSetLocalItem, mockRemoveLocalItem } = vi.hoisted(
  () => ({
    mockPreferences: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
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
