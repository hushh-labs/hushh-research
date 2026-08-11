import { describe, expect, it } from "vitest";

import {
  mergeRecipientsByUserId,
  resolveCircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import type {
  OneLocationCircleDetail,
  OneLocationRecipient,
} from "@/lib/one-location/types";

function circle(): OneLocationCircleDetail {
  return {
    id: "circle-1",
    name: "Family",
    kind: "family",
    role: "owner",
    memberCount: 4,
    memberLimit: 20,
    members: [
      {
        userId: "owner",
        displayName: "Me",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
        canReceiveLocation: true,
        keyId: "owner-key",
        publicKeyJwk: { kty: "EC" },
      },
      {
        userId: "ready",
        displayName: "Ready",
        role: "member",
        phoneVerified: true,
        secureLocationReady: true,
        canReceiveLocation: true,
        keyId: "ready-key",
        publicKeyJwk: { kty: "EC" },
      },
      {
        userId: "no-key",
        displayName: "No key",
        role: "member",
        phoneVerified: true,
        secureLocationReady: false,
        canReceiveLocation: false,
      },
      {
        userId: "no-phone",
        displayName: "No phone",
        role: "member",
        phoneVerified: false,
        secureLocationReady: true,
        canReceiveLocation: true,
        keyId: "phone-key",
        publicKeyJwk: { kty: "EC" },
      },
    ],
  };
}

describe("resolveCircleRecipientSelection", () => {
  it("returns a current ready snapshot and preserves exact Circle provenance", () => {
    const result = resolveCircleRecipientSelection({
      circle: circle(),
      currentUserId: "owner",
    });

    expect(result.ready.map((target) => target.recipient.userId)).toEqual([
      "ready",
      "no-phone",
    ]);
    expect(result.ready.every((target) => target.sourceCircleId === "circle-1"))
      .toBe(true);
    expect(result.excluded.map((item) => item.reason)).toEqual([
      "self",
      "location_setup_needed",
    ]);
  });

  it("excludes unverified phone members only for SMS contact selection", () => {
    const result = resolveCircleRecipientSelection({
      circle: circle(),
      currentUserId: "owner",
      requirePhoneVerified: true,
    });

    expect(result.ready.map((target) => target.recipient.userId)).toEqual([
      "ready",
    ]);
    expect(result.excluded.map((item) => item.reason)).toContain(
      "phone_verification_needed",
    );
  });

  it("deduplicates malformed duplicate roster entries", () => {
    const detail = circle();
    detail.members.push({ ...detail.members[1]! });

    expect(
      resolveCircleRecipientSelection({
        circle: detail,
        currentUserId: "owner",
      }).ready.filter((target) => target.recipient.userId === "ready"),
    ).toHaveLength(1);
  });
});

describe("mergeRecipientsByUserId", () => {
  it("keeps directory metadata while taking fresh Circle key material", () => {
    const directory: OneLocationRecipient = {
      userId: "ready",
      displayName: "Ready",
      phoneVerified: true,
      keyAlgorithm: "old",
      canReceiveLocation: false,
      recommendationTier: "trusted_circle",
    };
    const fromCircle: OneLocationRecipient = {
      userId: "ready",
      displayName: "Ready",
      phoneVerified: true,
      keyId: "new-key",
      publicKeyJwk: { kty: "EC" },
      keyAlgorithm: "new",
      canReceiveLocation: true,
    };

    expect(mergeRecipientsByUserId([directory], [fromCircle])).toEqual([
      expect.objectContaining({
        userId: "ready",
        keyId: "new-key",
        recommendationTier: "trusted_circle",
      }),
    ]);
  });
});
