// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  APPROXIMATE_GRID_DEGREES,
  APPROXIMATE_MIN_ACCURACY_M,
  coarsenPoint,
  pointMatchesPrecision,
  resolvePublishPrecision,
  snapToGrid,
} from "@/lib/location/coarsen";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const POINT: PlainLocationPoint = {
  latitude: 37.774929,
  longitude: -122.419416,
  accuracyM: 12,
  capturedAt: "2026-09-15T10:00:00.000Z",
  sourcePlatform: "ios",
  drive: {
    destination: { label: "Home", latitude: 37.78, longitude: -122.41 },
    etaSeconds: 600,
    distanceMeters: 4000,
    etaComputedAt: "2026-09-15T10:00:00.000Z",
  },
  checkIn: { message: "Here now" },
};

describe("snapToGrid", () => {
  it("snaps to the nearest 0.01 degree line", () => {
    expect(snapToGrid(37.774929)).toBe(37.77);
    expect(snapToGrid(37.776)).toBe(37.78);
    expect(snapToGrid(-122.419416)).toBe(-122.42);
    expect(snapToGrid(0.004999)).toBe(0);
  });

  it("is idempotent", () => {
    const once = snapToGrid(37.774929);
    expect(snapToGrid(once)).toBe(once);
    expect(snapToGrid(snapToGrid(-122.419416))).toBe(snapToGrid(-122.419416));
  });

  it("leaves non-finite input alone", () => {
    expect(Number.isNaN(snapToGrid(Number.NaN))).toBe(true);
  });
});

describe("coarsenPoint", () => {
  it("approximate snaps both axes, floors accuracy, drops drive, keeps the note", () => {
    const coarse = coarsenPoint(POINT, "approximate");
    expect(coarse.latitude).toBe(37.77);
    expect(coarse.longitude).toBe(-122.42);
    expect(coarse.accuracyM).toBe(APPROXIMATE_MIN_ACCURACY_M);
    expect(coarse.drive).toBeNull();
    expect(coarse.checkIn).toEqual({ message: "Here now" });
    expect(coarse.precision).toBe("approximate");
    expect(coarse.capturedAt).toBe(POINT.capturedAt);
    expect(coarse.sourcePlatform).toBe("ios");
  });

  it("keeps an accuracy that is already worse than the floor", () => {
    const coarse = coarsenPoint({ ...POINT, accuracyM: 2500 }, "approximate");
    expect(coarse.accuracyM).toBe(2500);
  });

  it("treats a missing accuracy as the floor", () => {
    const coarse = coarsenPoint({ ...POINT, accuracyM: null }, "approximate");
    expect(coarse.accuracyM).toBe(APPROXIMATE_MIN_ACCURACY_M);
  });

  it("precise leaves the coordinate untouched and tags it", () => {
    const precise = coarsenPoint(POINT, "precise");
    expect(precise.latitude).toBe(POINT.latitude);
    expect(precise.longitude).toBe(POINT.longitude);
    expect(precise.accuracyM).toBe(12);
    expect(precise.drive).toEqual(POINT.drive);
    expect(precise.precision).toBe("precise");
  });

  it("is idempotent: coarsening a coarse point changes nothing", () => {
    const once = coarsenPoint(POINT, "approximate");
    const twice = coarsenPoint(once, "approximate");
    expect(twice).toEqual(once);
  });

  it("is grid-stable: every point in a cell lands on the same output (no jitter)", () => {
    const outputs = new Set<string>();
    // Wander ~100 m around the true point, staying inside one grid cell.
    for (let index = 0; index < 50; index += 1) {
      const jitterLat = POINT.latitude - index * 0.00002;
      const jitterLng = POINT.longitude + (25 - index) * 0.00004;
      const coarse = coarsenPoint(
        { ...POINT, latitude: jitterLat, longitude: jitterLng },
        "approximate",
      );
      outputs.add(`${coarse.latitude},${coarse.longitude}`);
    }
    expect(outputs.size).toBe(1);
    // And the same input always yields the same output across calls.
    const a = coarsenPoint(POINT, "approximate");
    const b = coarsenPoint(POINT, "approximate");
    expect(a.latitude).toBe(b.latitude);
    expect(a.longitude).toBe(b.longitude);
  });

  it("never moves a point more than half a grid step per axis", () => {
    const coarse = coarsenPoint(POINT, "approximate");
    expect(Math.abs(coarse.latitude - POINT.latitude)).toBeLessThanOrEqual(
      APPROXIMATE_GRID_DEGREES / 2 + 1e-9,
    );
    expect(Math.abs(coarse.longitude - POINT.longitude)).toBeLessThanOrEqual(
      APPROXIMATE_GRID_DEGREES / 2 + 1e-9,
    );
  });

  it("SOS forces precise even when the preference is approximate", () => {
    const sos = coarsenPoint(POINT, "approximate", { sos: true });
    expect(sos.latitude).toBe(POINT.latitude);
    expect(sos.longitude).toBe(POINT.longitude);
    expect(sos.precision).toBe("precise");
    expect(sos.drive).toEqual(POINT.drive);
  });
});

describe("resolvePublishPrecision", () => {
  it("follows the stored preference by default", () => {
    expect(resolvePublishPrecision({ preference: "approximate" })).toBe(
      "approximate",
    );
    expect(resolvePublishPrecision({ preference: "precise" })).toBe("precise");
    expect(resolvePublishPrecision({ preference: null })).toBe("precise");
  });

  it("honours a server override", () => {
    expect(
      resolvePublishPrecision({
        preference: "approximate",
        override: "precise",
      }),
    ).toBe("precise");
    expect(
      resolvePublishPrecision({
        preference: "precise",
        override: "approximate",
      }),
    ).toBe("approximate");
  });

  it("SOS wins over everything", () => {
    expect(
      resolvePublishPrecision({
        preference: "approximate",
        override: "approximate",
        sos: true,
      }),
    ).toBe("precise");
    expect(
      resolvePublishPrecision({ preference: "approximate", purpose: "sos" }),
    ).toBe("precise");
  });
});

describe("pointMatchesPrecision", () => {
  it("treats an untagged point as precise", () => {
    expect(pointMatchesPrecision(POINT, "precise")).toBe(true);
    expect(pointMatchesPrecision(POINT, "approximate")).toBe(false);
    expect(
      pointMatchesPrecision(coarsenPoint(POINT, "approximate"), "approximate"),
    ).toBe(true);
  });
});
