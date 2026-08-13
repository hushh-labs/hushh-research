/**
 * Reuse and coalescing for `OneLocationService.captureCurrentPosition`.
 *
 * Every control on the One Location surface used to reach the device directly,
 * so a three-step share wizard paid for three full GPS acquisitions and sharing
 * with N people started N simultaneous ones. Each acquisition costs seconds,
 * which is the delay users reported on every button.
 *
 * These tests pin both halves of the fix AND the paths that must opt out of it:
 * a live share, a dropped pin and a check-in anchor are all wrong if answered
 * from a fix taken a moment ago somewhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentPosition = vi.fn();

vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    getCurrentPosition: (...args: unknown[]) => getCurrentPosition(...args),
  },
}));

import {
  CAPTURE_DEFAULT_MAX_AGE_MS,
  OneLocationService,
} from "@/lib/one-location/service";

function point(overrides?: { capturedAt?: string; accuracyM?: number | null }) {
  return {
    latitude: 19.076,
    longitude: 72.877,
    accuracyM: overrides?.accuracyM ?? 12,
    capturedAt: overrides?.capturedAt ?? new Date().toISOString(),
    sourcePlatform: "web" as const,
  };
}

describe("OneLocationService.captureCurrentPosition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T03:00:00.000Z"));
    getCurrentPosition.mockReset();
    OneLocationService.__resetCaptureCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  // Reuse — the delay fix.
  // ---------------------------------------------------------------------

  it("reads the device on the first call", async () => {
    getCurrentPosition.mockResolvedValue(point());
    await OneLocationService.captureCurrentPosition();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent fix instead of re-reading the device", async () => {
    // The wizard case: step 2 acquires, step 3 must not pay again.
    getCurrentPosition.mockResolvedValue(point());

    const first = await OneLocationService.captureCurrentPosition();
    vi.advanceTimersByTime(5_000);
    const second = await OneLocationService.captureCurrentPosition();

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-reads once the fix is older than the reuse window", async () => {
    getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();
    vi.advanceTimersByTime(CAPTURE_DEFAULT_MAX_AGE_MS + 1_000);
    getCurrentPosition.mockResolvedValue(
      point({ capturedAt: new Date().toISOString() }),
    );
    await OneLocationService.captureCurrentPosition();

    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("keeps the reuse window comfortably under the server freshness limit", () => {
    // The backend rejects a snapshot older than 60s between capture and
    // confirmation. A reuse window at or above that would ship points the
    // server then refuses — a share that fails for a reason the user cannot see.
    expect(CAPTURE_DEFAULT_MAX_AGE_MS).toBeLessThan(60_000);
  });

  it("re-reads when the stored fix has an unparseable timestamp", async () => {
    // Never treat a timestamp we cannot read as "fresh" — that would pin a
    // wrong position for the rest of the session.
    getCurrentPosition.mockResolvedValue(point({ capturedAt: "not-a-date" }));
    await OneLocationService.captureCurrentPosition();
    await OneLocationService.captureCurrentPosition();
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------
  // Coalescing — the share-with-many fix.
  // ---------------------------------------------------------------------

  it("collapses concurrent callers into one device read", async () => {
    // Sharing with several people at once used to start one GPS acquisition
    // per recipient, all competing for the same radio.
    let resolveCapture: (value: unknown) => void = () => undefined;
    getCurrentPosition.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );

    const captures = Promise.all([
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
      OneLocationService.captureCurrentPosition(),
    ]);

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    resolveCapture(point());
    const results = await captures;

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.capturedAt)).size).toBe(1);
  });

  it("joins an in-flight read even when the caller demands a fresh fix", async () => {
    // A read already running IS fresh — starting a second one would be slower
    // for both callers and no more accurate.
    let resolveCapture: (value: unknown) => void = () => undefined;
    getCurrentPosition.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );

    const cached = OneLocationService.captureCurrentPosition();
    const fresh = OneLocationService.captureCurrentPosition({ maxAgeMs: 0 });

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    resolveCapture(point());
    await expect(Promise.all([cached, fresh])).resolves.toHaveLength(2);
  });

  it("propagates a failure to every coalesced caller", async () => {
    getCurrentPosition.mockRejectedValue(new Error("Could not get your location."));

    const a = OneLocationService.captureCurrentPosition();
    const b = OneLocationService.captureCurrentPosition();

    await expect(a).rejects.toThrow(/Could not get your location/);
    await expect(b).rejects.toThrow(/Could not get your location/);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure — the next call retries the device", async () => {
    // A denied prompt the user then allows must not leave the surface stuck.
    getCurrentPosition.mockRejectedValueOnce(new Error("denied"));
    await expect(OneLocationService.captureCurrentPosition()).rejects.toThrow();

    getCurrentPosition.mockResolvedValue(point());
    await expect(
      OneLocationService.captureCurrentPosition(),
    ).resolves.toMatchObject({ latitude: 19.076 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------
  // Opt-outs — paths that are wrong if answered from cache.
  // ---------------------------------------------------------------------

  it("always reads the device when maxAgeMs is 0", async () => {
    // Live sharing, "locate me", and the check-in anchor all pass this.
    getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();
    vi.advanceTimersByTime(1_000);
    await OneLocationService.captureCurrentPosition({ maxAgeMs: 0 });

    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("honours a caller's tighter reuse window", async () => {
    getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();
    vi.advanceTimersByTime(3_000);
    await OneLocationService.captureCurrentPosition({ maxAgeMs: 1_000 });

    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("still serves a cached fix inside a caller's tighter window", async () => {
    getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();
    vi.advanceTimersByTime(500);
    await OneLocationService.captureCurrentPosition({ maxAgeMs: 1_000 });

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("forgets the fix when explicitly invalidated", async () => {
    getCurrentPosition.mockResolvedValue(point());

    await OneLocationService.captureCurrentPosition();
    OneLocationService.invalidateCapturedPosition();
    await OneLocationService.captureCurrentPosition();

    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("requests high accuracy with a bounded timeout", async () => {
    getCurrentPosition.mockResolvedValue(point());
    await OneLocationService.captureCurrentPosition();
    expect(getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
  });
});
