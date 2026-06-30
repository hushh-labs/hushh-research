import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Characterization: haptic toggle state processing on empty / irregular input.
 *
 * TRUTH CORRECTION — read before trusting the original task path
 * -------------------------------------------------------------
 * The task asked for a "public helper logic or action handler that computes or
 * tracks state for haptic switches" and to feed it "empty strings, strings
 * without flags, or undefined states".
 *
 * Verified repo truth: there is NO standalone haptic-toggle parser/handler.
 * `hapticFeedback` is a plain `boolean` field on `HushhSettings`, owned by the
 * exported `SettingsService` singleton in `lib/services/settings-service.ts`.
 * The only state-processing logic that touches it is `getSettings()`, which
 * reads a serialized blob from `@capacitor/preferences` and merges it over
 * `DEFAULT_SETTINGS` via `{ ...DEFAULT_SETTINGS, ...JSON.parse(value) }`, with a
 * try/catch that falls back to defaults on read/parse failure.
 *
 * So the genuine "empty / no-flag / undefined" behavior to characterize is:
 * how `SettingsService.getSettings()` resolves `hapticFeedback` when the stored
 * preferences payload is empty, malformed, missing the flag, or explicitly
 * undefined. This suite pins that real merge/fallback contract rather than a
 * fictional toggle helper. The file is kept at the requested
 * `__tests__/lib/services/` path per the task instruction.
 */

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
} from "@/lib/services/settings-service";

// Force the singleton to re-read Preferences instead of serving its cache.
function invalidateCache(): void {
  (SettingsService as unknown as { cachedSettings: unknown }).cachedSettings =
    null;
}

describe("haptic toggle state · empty / undefined / no-flag inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.remove.mockResolvedValue(undefined);
    invalidateCache();
  });

  it("defaults hapticFeedback to true when storage value is null (never set)", async () => {
    mockPreferences.get.mockResolvedValue({ value: null });

    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(true);
    expect(settings.hapticFeedback).toBe(DEFAULT_SETTINGS.hapticFeedback);
    expect(typeof settings.hapticFeedback).toBe("boolean");
  });

  it("falls back to default haptic state when the stored value is an empty string", async () => {
    // Empty string is falsy, so the service treats it as "no saved settings".
    mockPreferences.get.mockResolvedValue({ value: "" });
    invalidateCache();

    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(true);
    expect(typeof settings.hapticFeedback).toBe("boolean");
  });

  it("keeps the default haptic flag when stored JSON omits the haptic key (no-flag payload)", async () => {
    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify({ theme: "dark" }),
    });
    invalidateCache();

    const settings = await SettingsService.getSettings();

    // hapticFeedback was not present in the payload → inherited from defaults.
    expect(settings.hapticFeedback).toBe(true);
    expect(settings.theme).toBe("dark");
  });

  it("preserves an explicit undefined haptic value as the default after merge", async () => {
    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify({ hapticFeedback: undefined }),
    });
    invalidateCache();

    const settings = await SettingsService.getSettings();

    // JSON.stringify drops `undefined`, so the key never reaches the merge and
    // the default boolean wins — it must never collapse to undefined.
    expect(settings.hapticFeedback).toBe(true);
    expect(settings.hapticFeedback).not.toBeUndefined();
  });

  it("honors an explicit stored false haptic flag without falling back to the default", async () => {
    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify({ hapticFeedback: false }),
    });
    invalidateCache();

    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(false);
    expect(typeof settings.hapticFeedback).toBe("boolean");
  });

  it("falls back to a safe default haptic state when the stored payload is malformed JSON", async () => {
    mockPreferences.get.mockResolvedValue({ value: "{ not valid json" });
    invalidateCache();

    const settings = await SettingsService.getSettings();

    // Parse throws → caught → DEFAULT_SETTINGS returned wholesale.
    expect(settings.hapticFeedback).toBe(DEFAULT_SETTINGS.hapticFeedback);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults (haptic enabled) when the preferences read rejects", async () => {
    mockPreferences.get.mockRejectedValue(new Error("Storage unavailable"));
    invalidateCache();

    const settings = await SettingsService.getSettings();

    expect(settings.hapticFeedback).toBe(true);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });
});
