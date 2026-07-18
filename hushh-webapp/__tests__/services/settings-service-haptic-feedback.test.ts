import { beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for the `hapticFeedback` boolean preference in
// SettingsService. `hapticFeedback` is a single boolean on HushhSettings
// (not an array), so these tests pin down its default, merge, and persistence
// behavior against the real SettingsService surface.

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

describe("SettingsService hapticFeedback boolean", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPreferences.remove.mockResolvedValue(undefined);
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.get.mockResolvedValue({ value: null });
    await SettingsService.resetSettings();
  });

  it("defaults hapticFeedback to true in both default and production profiles", () => {
    expect(DEFAULT_SETTINGS.hapticFeedback).toBe(true);
    expect(PRODUCTION_SETTINGS.hapticFeedback).toBe(true);
    expect(typeof DEFAULT_SETTINGS.hapticFeedback).toBe("boolean");
  });

  it("returns the default hapticFeedback boolean when no settings are stored", async () => {
    const settings = await SettingsService.getSettings();
    expect(settings.hapticFeedback).toBe(true);
  });

  it("honors a stored hapticFeedback=false without dropping other defaults", async () => {
    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify({ hapticFeedback: false }),
    });

    // Invalidate cache so getSettings reads from Preferences.
    (SettingsService as unknown as { cachedSettings: unknown }).cachedSettings =
      null;
    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(false);
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.useRemoteSync).toBe(DEFAULT_SETTINGS.useRemoteSync);
  });

  it("falls back to the default hapticFeedback boolean when stored value is missing the key", async () => {
    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify({ theme: "dark" }),
    });

    (SettingsService as unknown as { cachedSettings: unknown }).cachedSettings =
      null;
    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(DEFAULT_SETTINGS.hapticFeedback);
    expect(settings.theme).toBe("dark");
  });

  it("persists a hapticFeedback toggle and notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = SettingsService.subscribe(listener);

    const updated = await SettingsService.updateSettings({
      hapticFeedback: false,
    });

    expect(updated.hapticFeedback).toBe(false);
    expect(mockPreferences.set).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.stringContaining('"hapticFeedback":false'),
      })
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ hapticFeedback: false })
    );

    unsubscribe();
  });

  it("restores the default hapticFeedback boolean after resetSettings", async () => {
    await SettingsService.updateSettings({ hapticFeedback: false });

    const settings = await SettingsService.resetSettings();

    expect(settings.hapticFeedback).toBe(DEFAULT_SETTINGS.hapticFeedback);
  });
});
