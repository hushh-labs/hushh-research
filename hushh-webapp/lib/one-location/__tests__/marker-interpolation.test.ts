import { describe, expect, it } from "vitest";
import {
  easeInOutQuad,
  haversineMeters,
  lerpLatLng,
  shouldSnap,
  SNAP_DISTANCE_METERS,
} from "@/lib/one-location/marker-interpolation";

describe("lerpLatLng", () => {
  it("returns the midpoint at t=0.5", () => {
    const mid = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
    expect(mid.lat).toBeCloseTo(5);
    expect(mid.lng).toBeCloseTo(10);
  });

  it("clamps t below 0 and above 1", () => {
    const from = { lat: 1, lng: 1 };
    const to = { lat: 3, lng: 3 };
    expect(lerpLatLng(from, to, -1)).toEqual(from);
    expect(lerpLatLng(from, to, 5)).toEqual(to);
  });
});

describe("easeInOutQuad", () => {
  it("maps endpoints to themselves and stays within [0,1]", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    const mid = easeInOutQuad(0.5);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(1);
  });
});

describe("haversineMeters", () => {
  it("is ~0 for identical points", () => {
    expect(
      haversineMeters({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 }),
    ).toBeCloseTo(0);
  });
});

describe("shouldSnap", () => {
  it("snaps when the jump exceeds the threshold", () => {
    expect(shouldSnap({ lat: 0, lng: 0 }, { lat: 40, lng: 20 })).toBe(true);
  });

  it("animates small movements", () => {
    expect(
      shouldSnap({ lat: 1.0, lng: 1.0 }, { lat: 1.00001, lng: 1.00001 }),
    ).toBe(false);
  });

  it("exposes a 2km threshold constant", () => {
    expect(SNAP_DISTANCE_METERS).toBe(2000);
  });
});
