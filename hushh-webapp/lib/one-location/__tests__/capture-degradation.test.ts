/**
 * What `captureCurrentPosition` does when the device does not answer.
 *
 * The reported symptom was a console line every twenty seconds — "Could not
 * get your location. Turn on Location for your device/browser and try again."
 * — on a session where permission was granted and a movement watch was
 * delivering fixes the whole time. The cause was two position stores: the bus,
 * which degrades to the position it is holding, and this service's own cache,
 * which had no such notion and simply threw. Every One Location surface was on
 * the second one.
 *
 * These tests pin the degradation AND its limits. A capture that never fails
 * loudly is worse than one that fails too often: the two cases below that must
 * still throw are the owner's only route out of a real block.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLocation, mockMemory } = vi.hoisted(() => ({
  mockLocation: {
    getPermissionState: vi.fn(),
    requestLocationPermission: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
  },
  mockMemory: {
    readLastKnownFix: vi.fn(),
    rememberLastKnownFix: vi.fn(),
    rememberLocationGrant: vi.fn(),
  },
}));

vi.mock("@/lib/capacitor", () => ({ HushhLocation: mockLocation }));
vi.mock("@/lib/one-location/location-grant-memory", () => ({
  LAST_KNOWN_FIX_RETENTION_MS: 24 * 60 * 60 * 1_000,
  readLastKnownFix: mockMemory.readLastKnownFix,
  rememberLastKnownFix: mockMemory.rememberLastKnownFix,
  rememberLocationGrant: mockMemory.rememberLocationGrant,
}));

import { LocationBus } from "@/lib/one-location/location-bus";
import {
  CAPTURE_DEFAULT_MAX_AGE_MS,
  CAPTURE_FRESH_MAX_AGE_MS,
  CAPTURE_STALE_FALLBACK_MAX_AGE_MS,
  OneLocationService,
} from "@/lib/one-location/service";

const USER = "user-alpha";

function point(overrides?: {
  capturedAt?: string;
  sourcePlatform?: "web" | "ios" | "android";
}) {
  return {
    latitude: 19.076,
    longitude: 72.877,
    accuracyM: 12,
    capturedAt: overrides?.capturedAt ?? new Date().toISOString(),
    sourcePlatform: overrides?.sourcePlatform ?? ("web" as const),
  };
}

/** What CoreLocation raises on a machine with no GPS radio. */
function positionUnavailable(): Error {
  const error = new Error(
    "Could not get your location. Turn on Location for your device/browser and try again.",
  );
  error.name = "LocationTimeoutError";
  (error as Error & { code?: number }).code = 3;
  return error;
}

function browserDenial(): Error {
  const error = new Error("Location permission is blocked for this site.");
  error.name = "LocationPermissionDeniedError";
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  LocationBus.__resetForTests();
  mockMemory.readLastKnownFix.mockResolvedValue(null);
  mockLocation.getPermissionState.mockResolvedValue({
    state: "granted",
    precise: true,
    background: "foreground-only",
  });
});

describe("captureCurrentPosition when the device stops answering", () => {
  it("returns the fix it is holding when a refresh fails for any reason but denial", async () => {
    mockLocation.getCurrentPosition.mockResolvedValueOnce(point());
    const first = await OneLocationService.captureCurrentPosition();

    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());
    const second = await OneLocationService.captureCurrentPosition({
      maxAgeMs: 0,
    });

    expect(second.latitude).toBe(first.latitude);
    expect(LocationBus.getState().status).toBe("stale");
  });

  it("still throws when the platform actually refused", async () => {
    mockLocation.getCurrentPosition.mockResolvedValueOnce(point());
    await OneLocationService.captureCurrentPosition();

    mockLocation.getCurrentPosition.mockRejectedValue(browserDenial());

    await expect(
      OneLocationService.captureCurrentPosition({ maxAgeMs: 0 }),
    ).rejects.toThrow(/blocked/i);
    expect(LocationBus.getState().status).toBe("denied");
  });

  it("throws the original error object, so a denial stays recognisable", async () => {
    mockLocation.getCurrentPosition.mockRejectedValue(browserDenial());

    // The name is the contract three platforms publish. Rebuilding the error
    // from a status string would erase it and leave callers matching prose.
    await expect(
      OneLocationService.captureCurrentPosition(),
    ).rejects.toMatchObject({ name: "LocationPermissionDeniedError" });
  });

  it("treats the native plugins' refusal string as a refusal", async () => {
    mockLocation.getCurrentPosition.mockResolvedValueOnce(point());
    await OneLocationService.captureCurrentPosition();

    // iOS and Android say this, and it names neither "denied" nor "blocked".
    mockLocation.getCurrentPosition.mockRejectedValue(
      new Error("Location permission was not granted."),
    );

    await expect(
      OneLocationService.captureCurrentPosition({ maxAgeMs: 0 }),
    ).rejects.toThrow(/not granted/i);
    expect(LocationBus.getState().status).toBe("denied");
  });

  it("still throws when nothing has ever been captured", async () => {
    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    await expect(OneLocationService.captureCurrentPosition()).rejects.toThrow(
      /Could not get your location/,
    );
    expect(LocationBus.getState().status).toBe("error");
  });

  it("refuses to serve a fix older than the stale-fallback budget", async () => {
    const ancient = new Date(
      Date.now() - (CAPTURE_STALE_FALLBACK_MAX_AGE_MS + 60_000),
    ).toISOString();
    mockLocation.getCurrentPosition.mockResolvedValueOnce(
      point({ capturedAt: ancient }),
    );
    await OneLocationService.captureCurrentPosition({ maxAgeMs: 0 });

    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    await expect(
      OneLocationService.captureCurrentPosition({ maxAgeMs: 0 }),
    ).rejects.toThrow();
  });
});

describe("captureCurrentPosition freshness policy after delegation", () => {
  it("keeps the reuse window under the server's freshness limit", async () => {
    // The bus allows two minutes by default; the backend rejects anything over
    // sixty seconds between capture and confirmation. Forwarding the window
    // explicitly is what stops a share failing for an invisible reason.
    const ensure = vi.spyOn(LocationBus, "ensure");
    mockLocation.getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();

    expect(ensure).toHaveBeenCalledWith({ maxAgeMs: CAPTURE_DEFAULT_MAX_AGE_MS });
    expect(CAPTURE_DEFAULT_MAX_AGE_MS).toBeLessThan(60_000);
    ensure.mockRestore();
  });

  it("forwards a caller's fresh intent as the tight window, not zero", async () => {
    const ensure = vi.spyOn(LocationBus, "ensure");
    mockLocation.getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition({ fresh: true });

    expect(ensure).toHaveBeenCalledWith({ maxAgeMs: CAPTURE_FRESH_MAX_AGE_MS });
    ensure.mockRestore();
  });

  it("preserves the platform the fix actually came from", async () => {
    // sourcePlatform is sealed into the envelope and shown to the recipient.
    // Rebuilding a point without it relabels every iPhone share as web.
    mockLocation.getCurrentPosition.mockResolvedValue(
      point({ sourcePlatform: "ios" }),
    );

    const captured = await OneLocationService.captureCurrentPosition();

    expect(captured.sourcePlatform).toBe("ios");
  });

  it("collapses concurrent callers into one device read after delegation", async () => {
    let release: ((value: unknown) => void) | null = null;
    mockLocation.getCurrentPosition.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const all = Promise.all([
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
    ]);
    release?.(point());
    const results = await all;

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.capturedAt)).size).toBe(1);
  });
});

describe("captureCurrentPosition and the previous session's fix", () => {
  it("serves the restored fix rather than failing a cold start", async () => {
    const restored = point({
      capturedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
    mockMemory.readLastKnownFix.mockResolvedValue(restored);
    await LocationBus.attachUser(USER);

    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    const captured = await OneLocationService.captureCurrentPosition();

    expect(captured.latitude).toBe(restored.latitude);
  });

  it("does not present a restored fix as a fresh one", async () => {
    // A surface that needs a measurement — the live publisher, a check-in
    // confirmation — reads the origin and refuses. If a restore ever passed as
    // "fresh", both would silently start asserting something untrue.
    const restored = point({
      capturedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
    mockMemory.readLastKnownFix.mockResolvedValue(restored);
    await LocationBus.attachUser(USER);

    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());
    await OneLocationService.captureCurrentPosition();

    expect(LocationBus.getState().snapshotOrigin).toBe("restored");
    expect(LocationBus.getState().status).not.toBe("ready");
  });
});
