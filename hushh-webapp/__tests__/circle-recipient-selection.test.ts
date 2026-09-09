import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  countSelectedCircleRecipients,
  isCircleSelectionFullySelected,
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
        connectedFromContacts: true,
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

describe("isCircleSelectionFullySelected", () => {
  const selection = () =>
    resolveCircleRecipientSelection({
      circle: {
        ...circle(),
        members: [
          ...circle().members!,
          {
            userId: "second-ready",
            displayName: "Second Ready",
            role: "member",
            phoneVerified: true,
            secureLocationReady: true,
            canReceiveLocation: true,
            keyId: "second-key",
            publicKeyJwk: { kty: "EC" },
          },
        ],
      },
      currentUserId: "owner",
    });

  it("holds only while every ready Circle member is still selected", () => {
    const resolved = selection();
    // Location sharing does not require phone verification, so "no-phone" is
    // part of the roster the Circle row claims to have selected.
    const readyIds = resolved.ready.map((target) => target.recipient.userId);
    expect(readyIds).toEqual(["ready", "no-phone", "second-ready"]);

    expect(isCircleSelectionFullySelected(resolved, readyIds)).toBe(true);
    // Extra hand-picked people outside the Circle do not break it.
    expect(
      isCircleSelectionFullySelected(resolved, [...readyIds, "outsider"]),
    ).toBe(true);
    // Deselecting one member below means this is no longer "the Circle".
    expect(
      isCircleSelectionFullySelected(resolved, readyIds.slice(0, -1)),
    ).toBe(false);
    expect(isCircleSelectionFullySelected(resolved, ["ready"])).toBe(false);
    expect(isCircleSelectionFullySelected(resolved, [])).toBe(false);
  });

  it("is false without a selection, and for a Circle with nobody ready", () => {
    expect(isCircleSelectionFullySelected(null, ["ready"])).toBe(false);
    expect(
      isCircleSelectionFullySelected({ ...selection(), ready: [] }, []),
    ).toBe(false);
  });
});

describe("countSelectedCircleRecipients", () => {
  it("does not let hand-picked outsiders inflate the Circle row count", () => {
    const resolved = resolveCircleRecipientSelection({
      circle: circle(),
      currentUserId: "owner",
    });
    const readyIds = resolved.ready.map((target) => target.recipient.userId);

    expect(readyIds).toEqual(["ready", "no-phone"]);
    expect(
      countSelectedCircleRecipients(resolved, [
        ...readyIds,
        "outsider-one",
        "outsider-two",
      ]),
    ).toBe(2);
  });

  it("counts the unique selected intersection for partial or empty state", () => {
    const resolved = resolveCircleRecipientSelection({
      circle: circle(),
      currentUserId: "owner",
    });

    expect(
      countSelectedCircleRecipients(resolved, ["ready", "ready", "outsider"]),
    ).toBe(1);
    expect(countSelectedCircleRecipients(resolved, [])).toBe(0);
    expect(countSelectedCircleRecipients(null, ["ready"])).toBe(0);
  });
});

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
    expect(result.ready[0]?.recipient.connectedFromContacts).toBe(true);
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


describe("Share uses the current Circle selection contract", () => {
  it("keeps a flat Circle list with trusted Circles excluded", () => {
    const hub = readFileSync(join(process.cwd(), "components/one-location/redesign/location-redesign-hub.tsx"), "utf8");
    const start = hub.indexOf("function ShareFlow(");
    const end = hub.indexOf("function AskFlow(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const share = hub.slice(start, end);
    expect(share).toContain('vm.circles.filter((circle) => circle.systemKind !== "trusted")');
    expect(share).toContain("vm.onSelectShareCircle(circle.id)");
    expect(share).not.toContain("shareCircleSections");
    expect(share).toContain("isCircleSelectionFullySelected(");
    expect(share).toContain("countSelectedCircleRecipients(");
  });
});
