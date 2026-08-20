import { describe, expect, it } from "vitest";

import type { OneLocationRecipient } from "@/lib/one-location/types";
import {
  isShareReadyRecipient,
  recipientSelectionFromIds,
  resolveEffectiveShareRecipients,
} from "@/lib/one-location/share-recipient-selection";

function recipient(overrides: Partial<OneLocationRecipient> = {}): OneLocationRecipient {
  return {
    userId: "user-1",
    displayName: "Jordan",
    phoneVerified: true,
    keyId: "key-1",
    publicKeyJwk: { kty: "EC" } as JsonWebKey,
    keyAlgorithm: "ECDH-ES",
    canReceiveLocation: true,
    ...overrides,
  };
}

const JORDAN = recipient({ userId: "user-1", displayName: "Jordan" });
const AVERY = recipient({ userId: "user-2", displayName: "Avery" });
const POOL = [JORDAN, AVERY];

describe("recipientSelectionFromIds", () => {
  it("resolves ids to recipients in the given order", () => {
    expect(recipientSelectionFromIds(POOL, ["user-2", "user-1"])).toEqual([
      AVERY,
      JORDAN,
    ]);
  });

  it("drops ids that are not in the pool instead of throwing", () => {
    expect(recipientSelectionFromIds(POOL, ["user-1", "ghost"])).toEqual([
      JORDAN,
    ]);
  });

  it("returns an empty list for an empty selection", () => {
    expect(recipientSelectionFromIds(POOL, [])).toEqual([]);
  });
});

describe("isShareReadyRecipient", () => {
  it("is ready when the person can receive location and has a registered key", () => {
    expect(isShareReadyRecipient(JORDAN)).toBe(true);
  });

  it("is not ready when canReceiveLocation is false", () => {
    expect(isShareReadyRecipient(recipient({ canReceiveLocation: false }))).toBe(
      false,
    );
  });

  it("is not ready when the recipient has never registered a key", () => {
    expect(
      isShareReadyRecipient(recipient({ keyId: null, publicKeyJwk: null })),
    ).toBe(false);
  });
});

describe("resolveEffectiveShareRecipients", () => {
  it("uses the reactive selection as-is when it is not empty", () => {
    // The common path: a render has already happened, so the reactive
    // selection is trusted over the ref-based fallback even if the two
    // happen to disagree (e.g. a stale ref from a previous share).
    expect(
      resolveEffectiveShareRecipients([JORDAN], POOL, ["user-2"]),
    ).toEqual([JORDAN]);
  });

  it("falls back to reconstructing from the ref-backed ids when the reactive selection is empty", () => {
    // The race this function exists to close: voice picks someone and says
    // "share" in the same breath, faster than the render that would have
    // made the pick visible in the reactive selection.
    expect(
      resolveEffectiveShareRecipients([], POOL, ["user-1", "user-2"]),
    ).toEqual([JORDAN, AVERY]);
  });

  it("returns an empty list when both the reactive selection and the fallback are empty", () => {
    expect(resolveEffectiveShareRecipients([], POOL, [])).toEqual([]);
  });

  it("does not mutate the inputs it is given", () => {
    const reactive = [JORDAN];
    const fallbackIds = ["user-2"];
    resolveEffectiveShareRecipients(reactive, POOL, fallbackIds);
    expect(reactive).toEqual([JORDAN]);
    expect(fallbackIds).toEqual(["user-2"]);
  });
});
