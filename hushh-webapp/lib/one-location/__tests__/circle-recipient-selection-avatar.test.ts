import { describe, expect, it } from "vitest";

import {
  mergeRecipientsByUserId,
  resolveCircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import type { OneLocationCircleDetail, OneLocationRecipient } from "@/lib/one-location/types";

const publicKeyJwk: JsonWebKey = { kty: "EC" };

describe("circle recipient avatar identity", () => {
  it("preserves member photo URLs when resolving Circle recipients", () => {
    const circle: OneLocationCircleDetail = {
      id: "circle-family",
      name: "Family",
      kind: "family",
      role: "owner",
      memberCount: 2,
      memberLimit: 100,
      members: [
        {
          userId: "person-1",
          displayName: "Roopmann V",
          photoUrl: "https://lh3.googleusercontent.com/avatar",
          role: "member",
          status: "active",
          phoneVerified: true,
          canReceiveLocation: true,
          keyId: "key-person-1",
          publicKeyJwk,
        },
      ],
    };

    const selection = resolveCircleRecipientSelection({ circle });

    expect(selection.ready[0]?.recipient.photoUrl).toBe(
      "https://lh3.googleusercontent.com/avatar",
    );
  });

  it("does not overwrite an existing recipient photo with a null Circle value", () => {
    const directoryRecipient: OneLocationRecipient = {
      userId: "person-1",
      displayName: "Roopmann V",
      photoUrl: "https://lh3.googleusercontent.com/directory-avatar",
      phoneVerified: true,
      keyAlgorithm: "test",
      canReceiveLocation: true,
    };
    const circleRecipient: OneLocationRecipient = {
      ...directoryRecipient,
      photoUrl: null,
      keyId: "key-person-1",
      publicKeyJwk,
    };

    expect(
      mergeRecipientsByUserId([directoryRecipient], [circleRecipient])[0]?.photoUrl,
    ).toBe("https://lh3.googleusercontent.com/directory-avatar");
  });
});
