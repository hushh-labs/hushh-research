import { describe, it, expect } from "vitest";
import { deriveEnRouteHelpers } from "../pickup-enroute";
import type { OneLocationGrant, PlainLocationPoint } from "@/lib/one-location/types";

function point(lat: number, lng: number, etaSeconds?: number): PlainLocationPoint {
  return {
    latitude: lat,
    longitude: lng,
    capturedAt: "2026-07-14T00:00:00.000Z",
    sourcePlatform: "web",
    drive:
      etaSeconds == null
        ? null
        : {
            destination: { label: "Pickup", latitude: 0, longitude: 0 },
            etaSeconds,
            distanceMeters: 1000,
            etaComputedAt: "2026-07-14T00:00:00.000Z",
          },
  } as PlainLocationPoint;
}

function grant(over: Partial<OneLocationGrant>): OneLocationGrant {
  return {
    id: "g",
    ownerUserId: "owner",
    recipientUserId: "me",
    shareKind: "pick_me_up",
    status: "active",
    ...over,
  } as unknown as OneLocationGrant;
}

const received: OneLocationGrant = grant({
  id: "recv-1",
  ownerUserId: "helper-1",
  recipientUserId: "me",
  shareKind: "pickup_enroute",
});
const outbound: OneLocationGrant = grant({
  id: "out-1",
  ownerUserId: "me",
  recipientUserId: "helper-1",
  shareKind: "pick_me_up",
});

describe("deriveEnRouteHelpers", () => {
  it("includes the requester's own pickup point from the outbound grant", () => {
    const helpers = deriveEnRouteHelpers({
      receivedGrants: [received],
      activeOwnerGrants: [outbound],
      decryptedPoints: {
        "recv-1": point(40.75, -74.05, 300), // helper live point + shipped ETA
        "out-1": point(40.76, -74.04), // requester pickup point
      },
      labelFor: () => "Alex",
    });
    expect(helpers).toHaveLength(1);
    expect(helpers[0].pickupPoint).toEqual(
      expect.objectContaining({ latitude: 40.76, longitude: -74.04 }),
    );
    expect(helpers[0].etaSeconds).toBe(300); // seed unchanged
  });

  it("sets pickupPoint to null when the outbound point is not decrypted", () => {
    const helpers = deriveEnRouteHelpers({
      receivedGrants: [received],
      activeOwnerGrants: [outbound],
      decryptedPoints: { "recv-1": point(40.75, -74.05, 300) },
      labelFor: () => "Alex",
    });
    expect(helpers[0].pickupPoint).toBeNull();
  });
});
