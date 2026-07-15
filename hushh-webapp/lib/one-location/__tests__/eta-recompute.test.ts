import { describe, it, expect } from "vitest";
import {
  DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
  DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS,
  shouldRecomputeEta,
} from "../eta-recompute";

const ORIGIN = { lat: 40.7518, lng: -74.0506 };

describe("shouldRecomputeEta", () => {
  it("recomputes on the first call (no prior compute)", () => {
    expect(
      shouldRecomputeEta({ lastComputedAt: null, lastOrigin: null, nextOrigin: ORIGIN, now: 1_000 }),
    ).toBe(true);
  });

  it("skips when within the interval and below the move threshold", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: { lat: ORIGIN.lat + 0.0001, lng: ORIGIN.lng }, // ~11 m
        now: 1_000 + 5_000,
      }),
    ).toBe(false);
  });

  it("recomputes once the move threshold is exceeded", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng }, // ~1.1 km
        now: 1_000 + 5_000,
      }),
    ).toBe(true);
  });

  it("recomputes once the interval has elapsed", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: ORIGIN,
        now: 1_000 + DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("exposes the verbatim constants", () => {
    expect(DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS).toBe(60_000);
    expect(DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS).toBe(250);
  });
});
