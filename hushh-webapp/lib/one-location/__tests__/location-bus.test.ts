import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLocation } = vi.hoisted(() => ({
  mockLocation: {
    getPermissionState: vi.fn(),
    requestLocationPermission: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
  },
}));

vi.mock("@/lib/capacitor", () => ({ HushhLocation: mockLocation }));

import { LocationBus } from "@/lib/one-location/location-bus";

const POINT = {
  latitude: 47.6769,
  longitude: -122.206,
  accuracyM: 12,
  capturedAt: new Date().toISOString(),
  sourcePlatform: "web" as const,
};

beforeEach(() => {
  LocationBus.__resetForTests();
  vi.clearAllMocks();
  mockLocation.getCurrentPosition.mockResolvedValue(POINT);
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
});

describe("LocationBus.ensure", () => {
  it("publishes a snapshot every subscriber can read", async () => {
    const seen: string[] = [];
    LocationBus.subscribe((state) => seen.push(state.status));

    const snapshot = await LocationBus.ensure();

    expect(snapshot?.latitude).toBe(47.6769);
    expect(LocationBus.getState().status).toBe("ready");
    expect(seen).toContain("locating");
    expect(seen).toContain("ready");
  });

  it("coalesces concurrent callers into a single device read", async () => {
    const [a, b, c] = await Promise.all([
      LocationBus.ensure(),
      LocationBus.ensure(),
      LocationBus.ensure(),
    ]);

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("reuses a fresh fix instead of re-hitting the GPS", async () => {
    await LocationBus.ensure();
    await LocationBus.ensure();

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the caller demands a live fix", async () => {
    await LocationBus.ensure();
    await LocationBus.ensure({ maxAgeMs: 0 });

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("treats a stale fix as absent", async () => {
    mockLocation.getCurrentPosition.mockResolvedValue({
      ...POINT,
      capturedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    await LocationBus.ensure();
    await LocationBus.ensure();

    expect(mockLocation.getCurrentPosition).toHaveBeenCalledTimes(2);
  });
});

describe("LocationBus permission handling", () => {
  it("records a denial as a state, not a thrown error", async () => {
    const denied = new Error("Location permission is blocked for this site.");
    denied.name = "LocationPermissionDeniedError";
    mockLocation.getCurrentPosition.mockRejectedValue(denied);

    const snapshot = await LocationBus.ensure();

    expect(snapshot).toBeNull();
    expect(LocationBus.getState().status).toBe("denied");
    expect(LocationBus.getState().permission).toBe("denied");
  });

  it("does not prompt when only syncing permission", async () => {
    await LocationBus.syncPermission();

    expect(mockLocation.requestLocationPermission).not.toHaveBeenCalled();
    expect(mockLocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(LocationBus.getState().permission).toBe("granted");
  });

  it("stops at the OS refusal instead of chasing a position", async () => {
    mockLocation.requestLocationPermission.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "unavailable",
    });

    const snapshot = await LocationBus.request();

    expect(snapshot).toBeNull();
    expect(mockLocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(LocationBus.getState().status).toBe("denied");
  });

  it("reports an unavailable device without offering a retry state", async () => {
    mockLocation.requestLocationPermission.mockResolvedValue({
      state: "unavailable",
      precise: false,
      background: "unavailable",
    });

    await LocationBus.request();

    expect(LocationBus.getState().status).toBe("unavailable");
  });

  it("recognises the native plugins' refusal, not just the browser's", async () => {
    // iOS and Android reject with this exact sentence and no custom error
    // name. The bus used to test the message against /denied|blocked/i, which
    // this sentence fails — so on a phone a real refusal was filed as a
    // transient failure. That is the one misclassification the degradation
    // path cannot survive: it would hand the owner their last known position
    // forever instead of the screen that gets them un-blocked.
    mockLocation.getCurrentPosition.mockRejectedValue(
      new Error("Location permission was not granted."),
    );

    const snapshot = await LocationBus.ensure();

    expect(snapshot).toBeNull();
    expect(LocationBus.getState().status).toBe("denied");
  });
});

describe("LocationBus.watch", () => {
  it("keeps exactly one device watch no matter how many surfaces subscribe", async () => {
    const stopA = await LocationBus.watch();
    const stopB = await LocationBus.watch();

    expect(mockLocation.watchPosition).toHaveBeenCalledTimes(1);

    stopA();
    expect(mockLocation.clearWatch).not.toHaveBeenCalled();

    stopB();
    expect(mockLocation.clearWatch).toHaveBeenCalledWith({ id: "watch-1" });
  });

  it("ignores a repeated stop from the same subscriber", async () => {
    const stopA = await LocationBus.watch();
    const stopB = await LocationBus.watch();

    stopA();
    stopA();
    expect(mockLocation.clearWatch).not.toHaveBeenCalled();

    stopB();
    expect(mockLocation.clearWatch).toHaveBeenCalledTimes(1);
  });

  it("publishes each movement fix to subscribers", async () => {
    let emit: ((point: unknown, error: unknown) => void) | null = null;
    mockLocation.watchPosition.mockImplementation(
      async (_options: unknown, callback: (p: unknown, e: unknown) => void) => {
        emit = callback;
        return "watch-1";
      },
    );

    await LocationBus.watch();
    emit?.({ ...POINT, latitude: 1.23 }, null);

    expect(LocationBus.getState().snapshot?.latitude).toBe(1.23);
    expect(LocationBus.getState().status).toBe("ready");
  });

  it("keeps the last fix visible through a transient watch error", async () => {
    let emit: ((point: unknown, error: unknown) => void) | null = null;
    mockLocation.watchPosition.mockImplementation(
      async (_options: unknown, callback: (p: unknown, e: unknown) => void) => {
        emit = callback;
        return "watch-1";
      },
    );

    await LocationBus.watch();
    emit?.(POINT, null);
    emit?.(null, { message: "timed out", code: 3 });

    expect(LocationBus.getState().status).toBe("ready");
    expect(LocationBus.getState().snapshot).not.toBeNull();
    // A watch reports unavailable/timeout routinely between fixes. Publishing
    // that message alongside a healthy snapshot is what put "Could not get your
    // location" on screen while location was working.
    expect(LocationBus.getState().error).toBeNull();
  });

  it("reports a permission denial even while a fix is still held", async () => {
    let emit: ((point: unknown, error: unknown) => void) | null = null;
    mockLocation.watchPosition.mockImplementation(
      async (_options: unknown, callback: (p: unknown, e: unknown) => void) => {
        emit = callback;
        return "watch-1";
      },
    );

    await LocationBus.watch();
    emit?.(POINT, null);
    emit?.(null, { message: "blocked for this site", code: 1 });

    expect(LocationBus.getState().status).toBe("denied");
    expect(LocationBus.getState().error).toBe("blocked for this site");
  });
});
