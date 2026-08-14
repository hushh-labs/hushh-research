// The bus half of "One should just know where I am".
//
// The behaviour under test is the one the screenshot showed: a device that knew
// exactly where it was minutes ago, opening to "we couldn't get a location
// reading" because the app held that answer in memory and the page had
// reloaded. `kCLErrorLocationUnknown` is not an exception on the machines that
// hit this — macOS and desktop Chrome emit it routinely, because there is no
// GPS radio to answer with.
//
// Durable storage is mocked here on purpose. What it stores and how long it
// keeps it is `location-grant-memory.test.ts`'s subject; what the bus does with
// a restored fix is this file's.

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

const USER = "user-alpha";

const FRESH_POINT = {
  latitude: 47.6769,
  longitude: -122.206,
  accuracyM: 12,
  capturedAt: new Date().toISOString(),
  sourcePlatform: "web" as const,
};

const RESTORED_POINT = {
  latitude: 19.0759837,
  longitude: 72.8776559,
  accuracyM: 40,
  capturedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
  sourcePlatform: "web" as const,
};

/** What CoreLocation actually raises on a machine with no GPS. */
function positionUnavailable(): Error {
  return new Error(
    "Could not get your location. Turn on Location for your device/browser and try again.",
  );
}

function denial(): Error {
  const error = new Error(
    "Location permission is blocked for this site. Allow location access in your browser's site settings, then try again.",
  );
  error.name = "LocationPermissionDeniedError";
  return error;
}

beforeEach(() => {
  LocationBus.__resetForTests();
  vi.clearAllMocks();
  mockLocation.getCurrentPosition.mockResolvedValue(FRESH_POINT);
  mockLocation.getPermissionState.mockResolvedValue({
    state: "granted",
    precise: true,
    background: "foreground-only",
  });
  mockLocation.requestLocationPermission.mockResolvedValue({
    state: "granted",
    precise: true,
    background: "foreground-only",
  });
  mockLocation.watchPosition.mockResolvedValue("watch-1");
  mockLocation.clearWatch.mockResolvedValue(undefined);
  mockMemory.readLastKnownFix.mockResolvedValue(null);
  mockMemory.rememberLastKnownFix.mockResolvedValue(undefined);
});

describe("attaching an account", () => {
  it("restores the previous session's fix", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);

    await LocationBus.attachUser(USER);

    const state = LocationBus.getState();
    expect(state.snapshot?.latitude).toBe(RESTORED_POINT.latitude);
    expect(state.snapshotOrigin).toBe("restored");
    expect(state.status).toBe("stale");
  });

  it("does not report a restored fix as ready", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);

    await LocationBus.attachUser(USER);

    // Every consumer written before durable memory gates on `ready` and means
    // "measured just now" by it. A restored coordinate must not start passing
    // those checks silently.
    expect(LocationBus.getState().status).not.toBe("ready");
  });

  it("stays idle when there is nothing to restore", async () => {
    await LocationBus.attachUser(USER);

    expect(LocationBus.getState().snapshot).toBeNull();
    expect(LocationBus.getState().status).toBe("idle");
  });

  it("reads storage once when several surfaces attach together", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);

    await Promise.all([
      LocationBus.attachUser(USER),
      LocationBus.attachUser(USER),
      LocationBus.attachUser(USER),
    ]);

    expect(mockMemory.readLastKnownFix).toHaveBeenCalledTimes(1);
  });

  it("clears one account's position the moment another signs in", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);
    await LocationBus.attachUser(USER);
    expect(LocationBus.getState().snapshot).not.toBeNull();

    mockMemory.readLastKnownFix.mockResolvedValue(null);
    await LocationBus.attachUser("user-beta");

    // Never a window in which one person's coordinate is visible under another
    // person's session.
    expect(LocationBus.getState().snapshot).toBeNull();
    expect(LocationBus.getState().snapshotOrigin).toBeNull();
  });

  it("stores nothing while no account is attached", async () => {
    await LocationBus.ensure();

    expect(mockMemory.rememberLastKnownFix).not.toHaveBeenCalled();
    expect(mockMemory.rememberLocationGrant).not.toHaveBeenCalled();
  });
});

describe("a transient failure with a position already in hand", () => {
  it("keeps the position instead of showing an error", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);
    await LocationBus.attachUser(USER);
    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    const result = await LocationBus.ensure({ maxAgeMs: 0 });

    // This is the reported bug, inverted into an assertion.
    expect(LocationBus.getState().status).not.toBe("error");
    expect(LocationBus.getState().status).toBe("stale");
    expect(LocationBus.getState().snapshot?.latitude).toBe(RESTORED_POINT.latitude);
    expect(result?.latitude).toBe(RESTORED_POINT.latitude);
  });

  it("never blanks a visible position while retrying", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);
    await LocationBus.attachUser(USER);
    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    const seen: (number | null)[] = [];
    LocationBus.subscribe((state) => seen.push(state.snapshot?.latitude ?? null));
    await LocationBus.ensure({ maxAgeMs: 0 });

    // A flash of "locating" with an empty map is the flicker this change
    // exists to remove.
    expect(seen.every((latitude) => latitude === RESTORED_POINT.latitude)).toBe(true);
  });

  it("still reports an error when there is no position at all", async () => {
    await LocationBus.attachUser(USER);
    mockLocation.getCurrentPosition.mockRejectedValue(positionUnavailable());

    await LocationBus.ensure({ maxAgeMs: 0 });

    // Suppressing this would hide a real dead end from someone who has no way
    // to know location is not working.
    expect(LocationBus.getState().status).toBe("error");
  });

  it("lets a real denial through even with a restored fix on screen", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);
    await LocationBus.attachUser(USER);
    mockLocation.getCurrentPosition.mockRejectedValue(denial());

    await LocationBus.ensure({ maxAgeMs: 0 });

    // "You said no" needs Settings; "the fix failed" needs a retry. A remembered
    // position must never soften the first into the second.
    expect(LocationBus.getState().status).toBe("denied");
    expect(LocationBus.getState().permission).toBe("denied");
  });
});

describe("a fresh fix", () => {
  it("replaces a restored one and records the grant", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue(RESTORED_POINT);
    await LocationBus.attachUser(USER);

    await LocationBus.ensure({ maxAgeMs: 0 });

    const state = LocationBus.getState();
    expect(state.status).toBe("ready");
    expect(state.snapshotOrigin).toBe("fresh");
    expect(state.snapshot?.latitude).toBe(FRESH_POINT.latitude);
    expect(mockMemory.rememberLocationGrant).toHaveBeenCalledWith(USER);
    expect(mockMemory.rememberLastKnownFix).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
    );
  });

  it("is still pursued when a restored fix looks recent", async () => {
    mockMemory.readLastKnownFix.mockResolvedValue({
      ...RESTORED_POINT,
      capturedAt: new Date().toISOString(),
    });
    await LocationBus.attachUser(USER);

    await LocationBus.ensure();

    // Reusing a restored fix because its timestamp is young would produce an app
    // that never refreshes as long as its own memory looks recent.
    expect(mockLocation.getCurrentPosition).toHaveBeenCalled();
    expect(LocationBus.getState().snapshotOrigin).toBe("fresh");
  });

  it("still short-circuits the GPS for a fix measured this session", async () => {
    await LocationBus.attachUser(USER);
    await LocationBus.ensure();
    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(1);

    await LocationBus.ensure();

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does not seal a coordinate on every movement tick", async () => {
    await LocationBus.attachUser(USER);

    await LocationBus.ensure({ maxAgeMs: 0 });
    await LocationBus.ensure({ maxAgeMs: 0 });
    await LocationBus.ensure({ maxAgeMs: 0 });

    // Each seal costs an ECDH derivation. Three fixes inside the throttle
    // window are worth exactly one write; the grant is refreshed every time
    // because it is two short strings.
    expect(mockMemory.rememberLastKnownFix).toHaveBeenCalledTimes(1);
    expect(mockMemory.rememberLocationGrant).toHaveBeenCalledTimes(3);
  });
});
