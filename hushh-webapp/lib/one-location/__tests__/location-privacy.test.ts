import { describe, expect, it } from "vitest";

import {
  approximateLocationPoint,
  pointForConnectionVisibility,
} from "@/lib/one-location/location-privacy";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 28.613939,
  longitude: 77.209021,
  accuracyM: 12,
  capturedAt: "2026-07-21T12:00:00.000Z",
  sourcePlatform: "android",
};

describe("connection visibility precision", () => {
  it("leaves precise points unchanged", () => {
    expect(pointForConnectionVisibility(point, "precise")).toBe(point);
  });

  it("coarsens coordinates before encryption and reports the privacy radius", () => {
    const approximate = approximateLocationPoint(point, 1_000);
    expect(approximate).not.toBe(point);
    expect(approximate.latitude).not.toBe(point.latitude);
    expect(approximate.longitude).not.toBe(point.longitude);
    expect(approximate.accuracyM).toBe(1_000);
    expect(approximate.capturedAt).toBe(point.capturedAt);
    expect(approximate.sourcePlatform).toBe("android");
  });

  it("bounds an invalid grid size to the supported privacy range", () => {
    expect(approximateLocationPoint(point, 1).accuracyM).toBe(250);
    expect(approximateLocationPoint(point, 50_000).accuracyM).toBe(5_000);
  });
});
