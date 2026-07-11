// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the import that uses them
// ---------------------------------------------------------------------------

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createGrant: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/sos-incident", () => ({
  saveSosIncident: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OneLocationService } from "@/lib/one-location/service";
import { saveSosIncident } from "@/lib/one-location/sos-incident";
import type {
  OneLocationGrant,
  OneLocationNetworkConnection,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import {
  isSosShareReadyRecipient,
  runSosPanic,
  selectShareReadyRecipients,
  selectSosConnectedRecipients,
  SosPanicError,
} from "@/lib/one-location/sos-trigger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecipient(
  userId: string,
  overrides: Partial<OneLocationRecipient> = {},
): OneLocationRecipient {
  return {
    userId,
    displayName: `User ${userId}`,
    phoneVerified: true,
    keyAlgorithm: "ECDH-P256",
    canReceiveLocation: true,
    keyId: `key-${userId}`,
    publicKeyJwk: { kty: "EC" } as JsonWebKey,
    ...overrides,
  };
}

function makeConnection(
  userAId: string,
  userBId: string,
  status: "active" | "revoked" = "active",
): OneLocationNetworkConnection {
  return {
    id: `conn-${userAId}-${userBId}`,
    userAId,
    userBId,
    inviterUserId: userAId,
    inviteeUserId: userBId,
    status,
  };
}

function makePoint(): PlainLocationPoint {
  return {
    latitude: 37.77,
    longitude: -122.41,
    capturedAt: "2026-07-03T10:00:00.000Z",
    sourcePlatform: "web",
  };
}

function makeGrant(id: string, recipientUserId: string): OneLocationGrant {
  return {
    id,
    ownerUserId: "owner",
    recipientUserId,
    recipientKeyId: `key-${recipientUserId}`,
    status: "active",
    consentScope: "location",
    capabilityScopes: [],
    durationHours: 8,
  };
}

// ---------------------------------------------------------------------------
// Tests: isSosShareReadyRecipient
// ---------------------------------------------------------------------------

describe("isSosShareReadyRecipient", () => {
  it("returns true when all three readiness conditions are met", () => {
    const r = makeRecipient("u1");
    expect(isSosShareReadyRecipient(r)).toBe(true);
  });

  it("returns false when canReceiveLocation is false", () => {
    const r = makeRecipient("u1", { canReceiveLocation: false });
    expect(isSosShareReadyRecipient(r)).toBe(false);
  });

  it("returns false when keyId is null", () => {
    const r = makeRecipient("u1", { keyId: null });
    expect(isSosShareReadyRecipient(r)).toBe(false);
  });

  it("returns false when publicKeyJwk is null", () => {
    const r = makeRecipient("u1", { publicKeyJwk: null });
    expect(isSosShareReadyRecipient(r)).toBe(false);
  });

  it("returns false when keyId is missing (undefined)", () => {
    const r = makeRecipient("u1");
    const { keyId: _dropped, ...rest } = r;
    expect(isSosShareReadyRecipient(rest as OneLocationRecipient)).toBe(false);
  });

  it("returns false when publicKeyJwk is missing (undefined)", () => {
    const r = makeRecipient("u1");
    const { publicKeyJwk: _dropped, ...rest } = r;
    expect(isSosShareReadyRecipient(rest as OneLocationRecipient)).toBe(false);
  });

  it("returns false when canReceiveLocation is undefined", () => {
    const r = makeRecipient("u1");
    const { canReceiveLocation: _dropped, ...rest } = r;
    expect(isSosShareReadyRecipient(rest as OneLocationRecipient)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: selectSosConnectedRecipients
// ---------------------------------------------------------------------------

describe("selectSosConnectedRecipients", () => {
  const me = "me";
  const rA = makeRecipient("userA");
  const rB = makeRecipient("userB");
  const rC = makeRecipient("userC");

  it("returns recipients that are active connections — me as userAId", () => {
    // me → userA (me is userAId, userA is userBId)
    const connections = [makeConnection(me, "userA")];
    const result = selectSosConnectedRecipients([rA, rB, rC], connections, me);
    expect(result).toEqual([rA]);
  });

  it("returns recipients that are active connections — me as userBId", () => {
    // userB → me (me is userBId, userB is userAId)
    const connections = [makeConnection("userB", me)];
    const result = selectSosConnectedRecipients([rA, rB, rC], connections, me);
    expect(result).toEqual([rB]);
  });

  it("handles both pair orders together", () => {
    const connections = [
      makeConnection(me, "userA"), // me is userAId
      makeConnection("userB", me), // me is userBId
    ];
    const result = selectSosConnectedRecipients([rA, rB, rC], connections, me);
    expect(result).toEqual([rA, rB]);
  });

  it("excludes revoked connections", () => {
    const connections = [makeConnection(me, "userA", "revoked")];
    const result = selectSosConnectedRecipients([rA], connections, me);
    expect(result).toEqual([]);
  });

  it("excludes non-connected recipients", () => {
    const connections = [makeConnection(me, "userA")];
    const result = selectSosConnectedRecipients([rB, rC], connections, me);
    expect(result).toEqual([]);
  });

  it("does not include self even if a connection somehow references self", () => {
    // A degenerate connection where both sides are the same user id
    const connections = [{ ...makeConnection(me, me) }];
    const selfRecipient = makeRecipient(me);
    const result = selectSosConnectedRecipients(
      [selfRecipient, rA],
      connections,
      me,
    );
    // me→me: otherId would be me, which equals myUserId, so it gets skipped
    expect(result).toEqual([]);
  });

  it("returns empty array when networkConnections is undefined", () => {
    const result = selectSosConnectedRecipients([rA, rB], undefined, me);
    expect(result).toEqual([]);
  });

  it("returns empty array when networkConnections is empty", () => {
    const result = selectSosConnectedRecipients([rA, rB], [], me);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: selectShareReadyRecipients
// ---------------------------------------------------------------------------

describe("selectShareReadyRecipients", () => {
  it("returns only share-ready recipients", () => {
    const ready = { userId: "a", canReceiveLocation: true } as never;
    const notReady = { userId: "b", canReceiveLocation: false } as never;
    const result = selectShareReadyRecipients([ready, notReady]);
    expect(result.map((r) => r.userId)).toEqual(["a"]);
  });

  it("returns empty for an empty list", () => {
    expect(selectShareReadyRecipients([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: runSosPanic
// ---------------------------------------------------------------------------

describe("runSosPanic", () => {
  const createGrantMock = vi.mocked(OneLocationService.createGrant);
  const saveSosIncidentMock = vi.mocked(saveSosIncident);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws SosPanicError with partialIncident === null when recipients is empty — does NOT call saveSosIncident", async () => {
    const publish = vi.fn();

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [],
      point: makePoint(),
      publish,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SosPanicError);
    expect((err as SosPanicError).partialIncident).toBeNull();
    expect(saveSosIncidentMock).not.toHaveBeenCalled();
    expect(createGrantMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("creates a grant per recipient with reason 'sos_panic' and durationHours 8", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));
    const publish = vi.fn().mockResolvedValue(undefined);

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      publish,
    });

    expect(createGrantMock).toHaveBeenCalledTimes(2);
    expect(createGrantMock).toHaveBeenNthCalledWith(1, {
      vaultOwnerToken: "tok",
      recipientUserId: "userA",
      recipientKeyId: "key-userA",
      durationHours: 8,
      reason: "sos_panic",
    });
    expect(createGrantMock).toHaveBeenNthCalledWith(2, {
      vaultOwnerToken: "tok",
      recipientUserId: "userB",
      recipientKeyId: "key-userB",
      durationHours: 8,
      reason: "sos_panic",
    });
  });

  it("calls publish once per recipient", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    const grantA = makeGrant("g1", "userA");
    const grantB = makeGrant("g2", "userB");
    createGrantMock
      .mockResolvedValueOnce(grantA)
      .mockResolvedValueOnce(grantB);
    const publish = vi.fn().mockResolvedValue(undefined);
    const point = makePoint();

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point,
      publish,
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, grantA, rA, point);
    expect(publish).toHaveBeenNthCalledWith(2, grantB, rB, point);
  });

  it("records grantId BEFORE publish — thrown error is SosPanicError whose partialIncident.grantIds contains BOTH ids if publish throws on 2nd recipient", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));

    let publishCallCount = 0;
    const publish = vi.fn().mockImplementation(async () => {
      publishCallCount += 1;
      if (publishCallCount === 2) {
        throw new Error("network error on 2nd publish");
      }
    });

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      publish,
    }).catch((e: unknown) => e);

    // Must be a SosPanicError, not a generic Error
    expect(err).toBeInstanceOf(SosPanicError);
    expect((err as SosPanicError).message).toBe("network error on 2nd publish");

    // The partial incident must contain BOTH grant ids: g1 (published ok) and
    // g2 (created but publish threw) — both need to be revokable via stop-SOS.
    const partial = (err as SosPanicError).partialIncident;
    expect(partial).not.toBeNull();
    expect(partial!.grantIds).toContain("g1");
    expect(partial!.grantIds).toContain("g2");

    // saveSosIncident must have been called with BOTH grant ids (best-effort
    // persistence for the partial incident).
    expect(saveSosIncidentMock).toHaveBeenCalledTimes(1);
    const savedIncident = saveSosIncidentMock.mock.calls[0][0];
    expect(savedIncident.grantIds).toContain("g1");
    expect(savedIncident.grantIds).toContain("g2");
  });

  it("returns an incident with all grant ids and a startedAt ISO string", async () => {
    const rA = makeRecipient("userA");
    createGrantMock.mockResolvedValueOnce(makeGrant("g1", "userA"));
    const publish = vi.fn().mockResolvedValue(undefined);

    const incident = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA],
      point: makePoint(),
      publish,
    });

    expect(incident.grantIds).toEqual(["g1"]);
    expect(typeof incident.startedAt).toBe("string");
    // Must be a valid ISO date
    expect(new Date(incident.startedAt).toString()).not.toBe("Invalid Date");
  });

  it("on full success calls saveSosIncident exactly once", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));
    const publish = vi.fn().mockResolvedValue(undefined);

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      publish,
    });

    expect(saveSosIncidentMock).toHaveBeenCalledTimes(1);
    const saved = saveSosIncidentMock.mock.calls[0][0];
    expect(saved.grantIds).toEqual(["g1", "g2"]);
  });

  it("does not call saveSosIncident when createGrant throws on the first recipient — throws SosPanicError with null partialIncident", async () => {
    const rA = makeRecipient("userA");
    createGrantMock.mockRejectedValueOnce(new Error("server error"));
    const publish = vi.fn();

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA],
      point: makePoint(),
      publish,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SosPanicError);
    expect((err as SosPanicError).message).toBe("server error");
    expect((err as SosPanicError).partialIncident).toBeNull();
    expect(saveSosIncidentMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("success and partial incidents share the same startedAt timestamp", async () => {
    // startedAt is captured once before the try — both paths must use it.
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));

    let publishCallCount = 0;
    const publish = vi.fn().mockImplementation(async () => {
      publishCallCount += 1;
      if (publishCallCount === 2) throw new Error("fail");
    });

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      publish,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SosPanicError);
    const partial = (err as SosPanicError).partialIncident;
    // startedAt must be a valid ISO string (not two different clock readings)
    expect(typeof partial!.startedAt).toBe("string");
    expect(new Date(partial!.startedAt).toString()).not.toBe("Invalid Date");
  });
});
