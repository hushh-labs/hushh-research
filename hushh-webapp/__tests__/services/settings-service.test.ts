import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPreferences } = vi.hoisted(() => ({
  mockPreferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: mockPreferences,
}));

vi.mock("react", () => ({
  useState: vi.fn((init: unknown) => [init, vi.fn()]),
  useEffect: vi.fn(),
}));

import {
  SettingsService,
  DEFAULT_SETTINGS,
  PRODUCTION_SETTINGS,
} from "@/lib/services/settings-service";

describe("SettingsService", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPreferences.remove.mockResolvedValue(undefined);
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.get.mockResolvedValue({ value: null });
    await SettingsService.resetSettings();
  });

  describe("getSettings", () => {
    it("returns defaults when no saved settings exist", async () => {
      const settings = await SettingsService.getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("merges saved settings with defaults on fresh load", async () => {
      const partial = { theme: "dark" as const, showDebugInfo: false };
      mockPreferences.get.mockResolvedValue({ value: JSON.stringify(partial) });

      // Invalidate internal cache so getSettings reads from Preferences
      (SettingsService as any).cachedSettings = null;
      const settings = await SettingsService.getSettings();

      expect(settings.theme).toBe("dark");
      expect(settings.showDebugInfo).toBe(false);
      expect(settings.useRemoteSync).toBe(DEFAULT_SETTINGS.useRemoteSync);
    });

    it("returns defaults when storage read fails", async () => {
      mockPreferences.get.mockRejectedValue(new Error("Storage unavailable"));

      (SettingsService as any).cachedSettings = null;
      const settings = await SettingsService.getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("uses cache on subsequent reads", async () => {
      const settings1 = await SettingsService.getSettings();
      const settings2 = await SettingsService.getSettings();

      expect(settings1).toBe(settings2);
    });
  });

  describe("updateSettings", () => {
    it("persists partial updates merged with current settings", async () => {
      await SettingsService.updateSettings({ theme: "light" });

      expect(mockPreferences.set).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.stringContaining('"theme":"light"'),
        })
      );
    });

    it("notifies subscribers on update", async () => {
      const listener = vi.fn();
      const unsubscribe = SettingsService.subscribe(listener);

      await SettingsService.updateSettings({ hapticFeedback: false });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ hapticFeedback: false })
      );

      unsubscribe();
    });

    it("throws when save fails", async () => {
      mockPreferences.set.mockRejectedValueOnce(new Error("Write failed"));

      await expect(
        SettingsService.updateSettings({ theme: "dark" })
      ).rejects.toThrow("Write failed");
    });
  });

  describe("resetSettings", () => {
    it("clears storage and returns defaults", async () => {
      const settings = await SettingsService.resetSettings();

      expect(mockPreferences.remove).toHaveBeenCalled();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("notifies subscribers with defaults after reset", async () => {
      const listener = vi.fn();
      SettingsService.subscribe(listener);

      await SettingsService.resetSettings();

      expect(listener).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    });
  });

  describe("convenience methods", () => {
    it("shouldUseLocalAgents returns true when useRemoteLLM is false", async () => {
      await SettingsService.updateSettings({ useRemoteLLM: false });
      expect(await SettingsService.shouldUseLocalAgents()).toBe(true);
    });

    it("shouldUseLocalAgents returns false when useRemoteLLM is true", async () => {
      await SettingsService.updateSettings({ useRemoteLLM: true });
      expect(await SettingsService.shouldUseLocalAgents()).toBe(false);
    });

    it("shouldSyncToCloud reflects useRemoteSync", async () => {
      expect(await SettingsService.shouldSyncToCloud()).toBe(false);
      await SettingsService.updateSettings({ useRemoteSync: true });
      expect(await SettingsService.shouldSyncToCloud()).toBe(true);
    });

    it("getLLMProvider returns local when remote is disabled", async () => {
      await SettingsService.updateSettings({ useRemoteLLM: false });
      expect(await SettingsService.getLLMProvider()).toBe("local");
    });

    it("getLLMProvider returns preferred provider when remote is enabled", async () => {
      await SettingsService.updateSettings({
        useRemoteLLM: true,
        preferredLLMProvider: "anthropic",
      });
      expect(await SettingsService.getLLMProvider()).toBe("anthropic");
    });
  });

  describe("PRODUCTION_SETTINGS", () => {
    it("has remote sync disabled", () => {
      expect(PRODUCTION_SETTINGS.useRemoteSync).toBe(false);
    });

    it("has remote LLM disabled", () => {
      expect(PRODUCTION_SETTINGS.useRemoteLLM).toBe(false);
    });

    it("has debug info disabled", () => {
      expect(PRODUCTION_SETTINGS.showDebugInfo).toBe(false);
    });
  });
});
