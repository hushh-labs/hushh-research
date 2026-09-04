import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HushhLocationWeb } from "@/lib/capacitor/plugins/location-web";

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;

type PositionOptions = { maximumAge?: number };

function position(latitude: number) {
  return {
    coords: { latitude, longitude: 12.34, accuracy: 20 },
    timestamp: Date.parse("2026-08-08T00:00:00.000Z"),
  };
}

/**
 * Install a geolocation stub whose fresh readers (`maximumAge: 0`) always fail,
 * while a cached fix remains available. This is the reported UAT shape: the
 * browser has Location on and a recent position in hand, but its provider
 * cannot produce a NEW fix right now.
 */
function stubGeolocation(options: {
  freshErrorCode: number;
  cachedLatitude: number | null;
}) {
  const getCurrentPosition = vi.fn(
    (
      onSuccess: (value: unknown) => void,
      onError: (error: unknown) => void,
      positionOptions?: PositionOptions,
    ) => {
      const wantsCached = (positionOptions?.maximumAge ?? 0) > 0;
      if (wantsCached && options.cachedLatitude !== null) {
        onSuccess(position(options.cachedLatitude));
        return;
      }
      onError({ code: options.freshErrorCode });
    },
  );
  const watchPosition = vi.fn(
    (_onSuccess: unknown, onError: (error: unknown) => void) => {
      // A watch only aborts sampling on a hard denial; anything else is left to
      // the sampling budget, so mirror that here.
      if (options.freshErrorCode === PERMISSION_DENIED) {
        onError({ code: PERMISSION_DENIED });
      }
      return 1;
    },
  );

  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition,
      watchPosition,
      clearWatch: vi.fn(),
    },
  });

  return { getCurrentPosition };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HushhLocationWeb.getCurrentPosition", () => {
  it("falls back to a recent cached fix when no fresh fix is available", async () => {
    const { getCurrentPosition } = stubGeolocation({
      freshErrorCode: POSITION_UNAVAILABLE,
      cachedLatitude: 47.6769,
    });

    const web = new HushhLocationWeb();
    // Attach the assertion before advancing timers so the promise is never
    // momentarily unhandled.
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ latitude: 47.6769 });
    await vi.runAllTimersAsync();
    await settled;

    // The cached read is a last resort: fresh reads are attempted first, and the
    // accepted fix must be recent enough to still pass the backend's freshness
    // window between capture and confirmation.
    const maxAges = getCurrentPosition.mock.calls.map(
      (call) => (call[2] as PositionOptions | undefined)?.maximumAge ?? 0,
    );
    expect(maxAges).toContain(0);
    expect(Math.max(...maxAges)).toBeLessThanOrEqual(30_000);
  });

  it("still fails when neither a fresh nor a cached fix exists", async () => {
    stubGeolocation({
      freshErrorCode: POSITION_UNAVAILABLE,
      cachedLatitude: null,
    });

    const web = new HushhLocationWeb();
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: 5_000 }),
    ).rejects.toThrow(/Could not get your location/i);
    await vi.runAllTimersAsync();
    await settled;
  });

  it("reports a blocked permission rather than a cached fix", async () => {
    stubGeolocation({
      freshErrorCode: PERMISSION_DENIED,
      cachedLatitude: 47.6769,
    });

    const web = new HushhLocationWeb();
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: "LocationPermissionDeniedError" });
    await vi.runAllTimersAsync();
    await settled;
  });
});

const SAMPLING_BUDGET_MS = 9_000;

/**
 * Install a geolocation whose watch delivers a scripted sequence of fixes. Each
 * assertion below advances the clock by only as much as the behaviour under
 * test should need, so a regression that reinstates the full-budget wait shows
 * up as an unresolved promise rather than a slower pass.
 */
function stubWatchSequence(
  fixes: Array<{ latitude: number; accuracy: number; afterMs: number }>,
) {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((onSuccess: (value: unknown) => void) => {
    for (const fix of fixes) {
      setTimeout(() => {
        onSuccess({
          coords: {
            latitude: fix.latitude,
            longitude: 12.34,
            accuracy: fix.accuracy,
          },
          timestamp: Date.parse("2026-08-08T00:00:00.000Z"),
        });
      }, fix.afterMs);
    }
    return 7;
  });

  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: vi.fn(),
      watchPosition,
      clearWatch,
    },
  });

  return { clearWatch };
}

describe("HushhLocationWeb.getCurrentPosition sampling window", () => {
  it("returns a coarse fix shortly after it lands instead of waiting out the budget", async () => {
    // A laptop with no GPS: one coarse fix arrives and no better one is ever
    // coming. Holding the caller for the remaining ~9s bought nothing, and it
    // was the single largest source of "turning location on takes forever".
    stubWatchSequence([{ latitude: 47.61, accuracy: 400, afterMs: 100 }]);

    const web = new HushhLocationWeb();
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: SAMPLING_BUDGET_MS }),
    ).resolves.toMatchObject({ latitude: 47.61, accuracyM: 400 });
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
  });

  it("still prefers a better fix that arrives inside the refinement window", async () => {
    // The reason sampling exists at all: one jumpy first reading must not be
    // shown as the person's location. Returning early must not cost that.
    stubWatchSequence([
      { latitude: 47.61, accuracy: 400, afterMs: 100 },
      { latitude: 47.68, accuracy: 60, afterMs: 400 },
    ]);

    const web = new HushhLocationWeb();
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: SAMPLING_BUDGET_MS }),
    ).resolves.toMatchObject({ latitude: 47.68, accuracyM: 60 });
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
  });

  it("resolves a confident fix immediately and stops watching", async () => {
    const { clearWatch } = stubWatchSequence([
      { latitude: 47.68, accuracy: 10, afterMs: 50 },
    ]);

    const web = new HushhLocationWeb();
    const settled = expect(
      web.getCurrentPosition({ timeoutMs: SAMPLING_BUDGET_MS }),
    ).resolves.toMatchObject({ latitude: 47.68, accuracyM: 10 });
    // Well inside the refinement window: an accurate fix never waits for it.
    await vi.advanceTimersByTimeAsync(60);
    await settled;
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});
