import { describe, expect, it } from "vitest";

import {
  restoreDriveSession,
  type PersistedDriveSession,
} from "@/lib/one-location/drive-session-store";
import type { DriveDestination } from "@/lib/one-location/types";

const destination: DriveDestination = {
  label: "Indira Gandhi Intl Airport · T3",
  latitude: 28.55,
  longitude: 77.1,
};

function persisted(grantIds: string[]): PersistedDriveSession {
  return {
    grantIds,
    destination,
    etaSeconds: 1080,
    distanceMeters: 7200,
    etaComputedAt: "2026-07-13T00:00:00.000Z",
  };
}

describe("restoreDriveSession", () => {
  it("returns null when there is no persisted session", () => {
    expect(restoreDriveSession(null, new Set(["g1"]))).toBeNull();
  });

  it("returns null when none of the persisted grants are still active", () => {
    expect(restoreDriveSession(persisted(["g1"]), new Set(["other"]))).toBeNull();
  });

  it("restores the session (filtered to active grants) with ETA preserved and a fresh recompute cursor", () => {
    const restored = restoreDriveSession(
      persisted(["g1", "expired"]),
      new Set(["g1", "g2"]),
    );
    expect(restored).not.toBeNull();
    expect([...restored!.grantIds]).toEqual(["g1"]); // "expired" dropped, "g2" not ours
    expect(restored!.destination).toEqual(destination);
    expect(restored!.etaSeconds).toBe(1080); // last-known ETA shown immediately
    expect(restored!.lastEtaPoint).toBeNull(); // forces a recompute on next publish
    expect(restored!.lastEtaAt).toBe(0);
  });
});
