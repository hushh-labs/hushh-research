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
