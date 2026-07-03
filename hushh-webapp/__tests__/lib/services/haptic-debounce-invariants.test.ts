import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Characterization: haptic preference multi-event update invariants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PREMISE CORRECTION (truth-first)
 * ─────────────────────────────────────────────────────────────────────────────
 * The task framing ("haptic *debounce* helpers", "pointer references out of
 * sync") does NOT match the repo. There is:
 *   - NO debounce/throttle/timer logic for haptics anywhere.
 *   - NO "pointer references" — this is TypeScript/JS, not manual memory.
 *
 * The real, exported surface is `SettingsService`
 * (`hushh-webapp/lib/services/settings-service.ts`). `hapticFeedback` is a plain
 * `boolean` field on `HushhSettings`. It is mutated through
 * `updateSettings(updates)`, which:
 *   1. reads current (cached) settings,
 *   2. shallow-merges `{ ...current, ...updates }` (last-write-wins),
 *   3. persists via Capacitor `Preferences.set`,
 *   4. updates the in-memory cache, then
 *   5. synchronously notifies every subscriber with the SAME new object.
 *
 * So the meaningful, real invariant to pin for "sequential, immediate state
 * dispatches" is: back-to-back `updateSettings` calls converge to a coherent,
 * last-write-wins state; every subscriber sees the final value; and the cached
 * object handed to listeners is reference-identical to what `getSettings`
 * returns (no torn/desynced reads). These specs pin exactly that.
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

// Keep the React hook import inert; we only exercise the service singleton.
vi.mock("react", () => ({
  useState: vi.fn((init: unknown) => [init, vi.fn()]),
  useEffect: vi.fn(),
}));

import {
  SettingsService,
  DEFAULT_SETTINGS,
  type HushhSettings,
} from "@/lib/services/settings-service";


describe("SettingsService.hapticFeedback — sequential rapid update invariants", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPreferences.remove.mockResolvedValue(undefined);
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.get.mockResolvedValue({ value: null });
    await SettingsService.resetSettings();
  });

  it("baseline: hapticFeedback defaults to true", async () => {
    const settings = await SettingsService.getSettings();
    expect(settings.hapticFeedback).toBe(DEFAULT_SETTINGS.hapticFeedback);
    expect(settings.hapticFeedback).toBe(true);
  });

  it("awaited back-to-back toggles converge to the last write (last-write-wins)", async () => {
    await SettingsService.updateSettings({ hapticFeedback: false });
    await SettingsService.updateSettings({ hapticFeedback: true });
    await SettingsService.updateSettings({ hapticFeedback: false });

    const settings = await SettingsService.getSettings();
    expect(settings.hapticFeedback).toBe(false);
  });

  it("immediate (non-awaited) rapid dispatches settle to the final value", async () => {
    // Fire without awaiting each — simulate high-frequency UI toggling.
    const results = await Promise.all([
      SettingsService.updateSettings({ hapticFeedback: false }),
      SettingsService.updateSettings({ hapticFeedback: true }),
      SettingsService.updateSettings({ hapticFeedback: false }),
      SettingsService.updateSettings({ hapticFeedback: true }),
    ]);

    // Every resolved snapshot is a coherent HushhSettings object (no torn state).
    for (const snapshot of results) {
      expect(typeof snapshot.hapticFeedback).toBe("boolean");
      expect(snapshot.theme).toBe(DEFAULT_SETTINGS.theme);
    }

    // Final converged state matches the last dispatch.
    const settings = await SettingsService.getSettings();
    expect(settings.hapticFeedback).toBe(true);
  });

  it("subscribers observe every dispatch and end on the final value", async () => {
    const seen: boolean[] = [];
    const unsubscribe = SettingsService.subscribe((s: HushhSettings) =>
      seen.push(s.hapticFeedback)
    );


    await SettingsService.updateSettings({ hapticFeedback: false });
    await SettingsService.updateSettings({ hapticFeedback: true });
    await SettingsService.updateSettings({ hapticFeedback: false });

    unsubscribe();

    expect(seen).toEqual([false, true, false]);
    // After unsubscribe, further updates are not observed.
    await SettingsService.updateSettings({ hapticFeedback: true });
    expect(seen).toEqual([false, true, false]);
  });

  it("listener payload is reference-identical to the cached getSettings result (no desync)", async () => {
    let lastPayload: unknown = null;
    const unsubscribe = SettingsService.subscribe((s: HushhSettings) => {
      lastPayload = s;
    });


    const returned = await SettingsService.updateSettings({
      hapticFeedback: false,
    });
    const fetched = await SettingsService.getSettings();

    // The object dispatched to listeners, returned from updateSettings, and
    // served by getSettings is one and the same cached reference.
    expect(lastPayload).toBe(returned);
    expect(fetched).toBe(returned);

    unsubscribe();
  });

  it("rapid toggling only mutates hapticFeedback, leaving sibling settings intact", async () => {
    const before = await SettingsService.getSettings();
    const siblingsBefore = { ...before, hapticFeedback: "IGNORED" };

    await SettingsService.updateSettings({ hapticFeedback: false });
    await SettingsService.updateSettings({ hapticFeedback: true });

    const after = await SettingsService.getSettings();
    const siblingsAfter = { ...after, hapticFeedback: "IGNORED" };

    expect(siblingsAfter).toEqual(siblingsBefore);
  });

  it("each awaited update returns the fully merged, persistable state", async () => {
    const first = await SettingsService.updateSettings({
      hapticFeedback: false,
    });
    expect(first.hapticFeedback).toBe(false);

    const second = await SettingsService.updateSettings({
      hapticFeedback: true,
    });
    expect(second.hapticFeedback).toBe(true);

    // The merged snapshot is JSON-serializable exactly as it is handed to the
    // Preferences layer (no functions / circular refs leak into persistence).
    const serialized = JSON.parse(JSON.stringify(second)) as HushhSettings;
    expect(serialized.hapticFeedback).toBe(true);
    expect(serialized.theme).toBe(DEFAULT_SETTINGS.theme);
  });

});
