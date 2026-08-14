import { describe, expect, it } from "vitest";

import { samePlainLocationPoint } from "@/lib/one-location/location-workspace-memory";
import type { PlainLocationPoint } from "@/lib/one-location/types";

function point(overrides: Partial<PlainLocationPoint> = {}): PlainLocationPoint {
  return {
    latitude: 28.6139,
    longitude: 77.209,
    accuracyM: 141,
    capturedAt: "2026-08-14T17:31:00.000Z",
    sourcePlatform: "web",
    ...overrides,
  } as PlainLocationPoint;
}

describe("samePlainLocationPoint", () => {
  it("treats a republished identical point as unchanged", () => {
    // The case that matters: a stationary owner's heartbeat decrypts to the
    // same values every few seconds. This is what stops the live poll from
    // re-rendering the whole Location surface for no visible change.
    expect(samePlainLocationPoint(point(), point())).toBe(true);
  });

  it("is reference-safe and null-safe", () => {
    const p = point();
    expect(samePlainLocationPoint(p, p)).toBe(true);
    expect(samePlainLocationPoint(null, null)).toBe(true);
    expect(samePlainLocationPoint(undefined, undefined)).toBe(true);
    expect(samePlainLocationPoint(p, null)).toBe(false);
    expect(samePlainLocationPoint(null, p)).toBe(false);
  });

  it("detects movement", () => {
    expect(
      samePlainLocationPoint(point(), point({ latitude: 28.62 })),
    ).toBe(false);
    expect(
      samePlainLocationPoint(point(), point({ longitude: 77.3 })),
    ).toBe(false);
  });

  it("detects a fresh fix at the same coordinates", () => {
    // Standing still still produces new readings; the timestamp is what drives
    // the "Live · 11s ago" freshness label.
    expect(
      samePlainLocationPoint(
        point(),
        point({ capturedAt: "2026-08-14T17:31:20.000Z" }),
      ),
    ).toBe(false);
  });

  it("detects an accuracy change, including to and from null", () => {
    expect(samePlainLocationPoint(point(), point({ accuracyM: 12 }))).toBe(
      false,
    );
    expect(samePlainLocationPoint(point(), point({ accuracyM: null }))).toBe(
      false,
    );
    // Absent and explicit-null are the same absence, not a change.
    expect(
      samePlainLocationPoint(
        point({ accuracyM: null }),
        point({ accuracyM: undefined }),
      ),
    ).toBe(true);
  });

  it("detects a platform change", () => {
    expect(
      samePlainLocationPoint(point(), point({ sourcePlatform: "ios" })),
    ).toBe(false);
  });

  describe("Drive-To shares", () => {
    const drive = {
      destination: {
        label: "Office",
        latitude: 28.7,
        longitude: 77.1,
        placeId: "place-1",
      },
      etaSeconds: 900,
      distanceMeters: 4200,
      etaComputedAt: "2026-08-14T17:31:00.000Z",
    };

    it("detects an ETA recomputed at unchanged coordinates", () => {
      // The regression a coordinates-only check would cause: the ETA is
      // recomputed on its own schedule, so a driver stopped at a light would
      // see the countdown freeze while the point looked "unchanged".
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({ drive: { ...drive, etaSeconds: 780 } }),
        ),
      ).toBe(false);
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({ drive: { ...drive, distanceMeters: 3100 } }),
        ),
      ).toBe(false);
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({
            drive: { ...drive, etaComputedAt: "2026-08-14T17:32:00.000Z" },
          }),
        ),
      ).toBe(false);
    });

    it("detects a changed destination", () => {
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({
            drive: { ...drive, destination: { ...drive.destination, label: "Home" } },
          }),
        ),
      ).toBe(false);
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({
            drive: {
              ...drive,
              destination: { ...drive.destination, latitude: 28.8 },
            },
          }),
        ),
      ).toBe(false);
      expect(
        samePlainLocationPoint(
          point({ drive }),
          point({
            drive: {
              ...drive,
              destination: { ...drive.destination, placeId: "place-2" },
            },
          }),
        ),
      ).toBe(false);
    });

    it("detects a share starting or ending a drive", () => {
      expect(samePlainLocationPoint(point(), point({ drive }))).toBe(false);
      expect(samePlainLocationPoint(point({ drive }), point())).toBe(false);
      expect(
        samePlainLocationPoint(point({ drive }), point({ drive: null })),
      ).toBe(false);
    });

    it("treats an identical drive payload as unchanged", () => {
      expect(
        samePlainLocationPoint(point({ drive }), point({ drive: { ...drive } })),
      ).toBe(true);
    });
  });

  describe("Check-In shares", () => {
    it("detects an edited note at unchanged coordinates", () => {
      expect(
        samePlainLocationPoint(
          point({ checkIn: { message: "At the cafe" } }),
          point({ checkIn: { message: "Leaving now" } }),
        ),
      ).toBe(false);
    });

    it("detects a note being added or cleared", () => {
      expect(
        samePlainLocationPoint(point(), point({ checkIn: { message: "Here" } })),
      ).toBe(false);
      expect(
        samePlainLocationPoint(point({ checkIn: { message: "Here" } }), point()),
      ).toBe(false);
    });

    it("treats an identical note as unchanged", () => {
      expect(
        samePlainLocationPoint(
          point({ checkIn: { message: "At the cafe" } }),
          point({ checkIn: { message: "At the cafe" } }),
        ),
      ).toBe(true);
    });
  });
});
