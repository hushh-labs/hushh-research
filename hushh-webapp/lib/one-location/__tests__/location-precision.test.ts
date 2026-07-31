import { describe, expect, it } from "vitest";

import {
  APPROXIMATE_AREA_MIN_RADIUS_M,
  approximateAreaCenter,
  approximateAreaRadiusM,
  prepareLocationPointForSharing,
  validateLocationPointForGrant,
} from "@/lib/one-location/location-precision";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 25.213815,
  longitude: 75.864752,
  accuracyM: 12,
  capturedAt: "2026-08-01T10:00:00.000Z",
  sourcePlatform: "web",
};

describe("One Location precision contract", () => {
  it("keeps precise points exact and marks the encrypted payload", () => {
    expect(prepareLocationPointForSharing(point, "precise")).toEqual({
      ...point,
      locationMode: "precise",
      approximateRadiusM: null,
    });
  });

  it("moves approximate points to a deterministic 1 km grid centre", () => {
    const first = prepareLocationPointForSharing(point, "approximate");
    const nearby = prepareLocationPointForSharing(
      { ...point, latitude: point.latitude + 0.0001 },
      "approximate",
    );
    expect(first.locationMode).toBe("approximate");
    expect(first.latitude).not.toBe(point.latitude);
    expect(first.longitude).not.toBe(point.longitude);
    expect(first.latitude).toBe(nearby.latitude);
    expect(first.longitude).toBe(nearby.longitude);
    expect(first.approximateRadiusM).toBe(APPROXIMATE_AREA_MIN_RADIUS_M);
    expect(first.accuracyM).toBe(first.approximateRadiusM);
  });

  it("widens the displayed area when the device reading is coarse", () => {
    expect(approximateAreaRadiusM(3_000)).toBeGreaterThan(3_000);
  });

  it("fails closed when device uncertainty cannot fit inside the maximum area", () => {
    expect(() =>
      prepareLocationPointForSharing(
        { ...point, accuracyM: 50_000 },
        "approximate",
      ),
    ).toThrow(/accuracy is too limited/i);
  });

  it.each([
    { latitude: 0, longitude: 179.9999 },
    { latitude: 0, longitude: -179.9999 },
    { latitude: 89.9, longitude: 45 },
    { latitude: -89.9, longitude: -45 },
  ])("returns finite bounded centres at map edges", (edge) => {
    const center = approximateAreaCenter(edge);
    expect(Number.isFinite(center.latitude)).toBe(true);
    expect(Number.isFinite(center.longitude)).toBe(true);
    expect(center.latitude).toBeGreaterThanOrEqual(-85.05112878);
    expect(center.latitude).toBeLessThanOrEqual(85.05112878);
    expect(center.longitude).toBeGreaterThanOrEqual(-180);
    expect(center.longitude).toBeLessThanOrEqual(180);
  });

  it("fails closed when an approximate grant decrypts an exact or mismatched point", () => {
    expect(() =>
      validateLocationPointForGrant({
        point,
        grant: { locationMode: "approximate", approximateRadiusM: 1_000 },
      }),
    ).toThrow(/privacy check/i);

    const approximate = prepareLocationPointForSharing(point, "approximate");
    expect(() =>
      validateLocationPointForGrant({
        point: { ...approximate, latitude: approximate.latitude + 0.00001 },
        grant: {
          locationMode: "approximate",
          approximateRadiusM: approximate.approximateRadiusM,
        },
      }),
    ).toThrow(/privacy check/i);
  });
});
