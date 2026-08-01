// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the import that uses them
// ---------------------------------------------------------------------------

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createGrantWithEnvelope: vi.fn(),
    revokeGrant: vi.fn(),
    getPermissionState: vi.fn(async () => ({
      state: "granted",
      precise: true,
    })),
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
  runSosPanic as runSosPanicCore,
  selectSmsRecipients,
  selectShareReadyRecipients,
  selectSosConnectedRecipients,
  SosPanicError,
} from "@/lib/one-location/sos-trigger";

const runSosPanic = (
  params: Omit<Parameters<typeof runSosPanicCore>[0], "userId">,
) => runSosPanicCore({ ...params, userId: "owner" });

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
    locationMode: "precise",
    approximateRadiusM: null,
    latestEnvelopeId: `envelope-${id}`,
  };
}

function makeAtomicResponse(id: string, recipientUserId: string) {
  return {
    grant: makeGrant(id, recipientUserId),
    envelope: { id: `envelope-${id}` },
    idempotentReplay: false,
  } as never;
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

describe("selectSmsRecipients", () => {
  const recipients = [
    makeRecipient("a"),
    makeRecipient("b"),
    makeRecipient("c"),
  ];

  it("returns only explicitly selected recipients", () => {
    expect(
      selectSmsRecipients(recipients, ["a", "c"]).map(
        (recipient) => recipient.userId,
      ),
    ).toEqual(["a", "c"]);
  });

  it("fails closed for an empty or unavailable selection", () => {
    expect(selectSmsRecipients(recipients, [])).toEqual([]);
    expect(selectSmsRecipients(recipients, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: runSosPanic
// ---------------------------------------------------------------------------

describe("runSosPanic", () => {
  const createGrantMock = vi.mocked(OneLocationService.createGrantWithEnvelope);
  const saveSosIncidentMock = vi.mocked(saveSosIncident);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws SosPanicError with partialIncident === null when recipients is empty — does NOT call saveSosIncident", async () => {
    const prepareEnvelope = vi.fn();

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [],
      point: makePoint(),
      prepareEnvelope,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SosPanicError);
    expect((err as SosPanicError).partialIncident).toBeNull();
    expect(saveSosIncidentMock).not.toHaveBeenCalled();
    expect(createGrantMock).not.toHaveBeenCalled();
    expect(prepareEnvelope).not.toHaveBeenCalled();
  });

  it("creates a grant per recipient with reason 'sos_panic' and durationHours 8", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA"))
      .mockResolvedValueOnce(makeAtomicResponse("g2", "userB"));
    const prepareEnvelope = vi.fn(
      async (recipient) => ({ id: `client-${recipient.userId}` }) as never,
    );

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      operationId: "sos-action",
      prepareEnvelope,
    });

    expect(createGrantMock).toHaveBeenCalledTimes(2);
    expect(createGrantMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        vaultOwnerToken: "tok",
        recipientUserId: "userA",
        recipientKeyId: "key-userA",
        durationHours: 8,
        reason: "sos_panic",
        shareKind: "sos",
        locationMode: "precise",
        approximateRadiusM: null,
        clientOperationId: "sos:sos-action:userA",
      }),
    );
    expect(createGrantMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        vaultOwnerToken: "tok",
        recipientUserId: "userB",
        recipientKeyId: "key-userB",
        durationHours: 8,
        reason: "sos_panic",
        shareKind: "sos",
        locationMode: "precise",
        approximateRadiusM: null,
        clientOperationId: "sos:sos-action:userB",
      }),
    );
  });

  it("allows exact web SOS when the browser cannot expose a precision tier", async () => {
    vi.mocked(OneLocationService.getPermissionState)
      .mockResolvedValueOnce({
        state: "granted",
        precise: null,
        background: "foreground-only",
      })
      .mockResolvedValueOnce({
        state: "granted",
        precise: null,
        background: "foreground-only",
      });
    createGrantMock.mockResolvedValueOnce(
      makeAtomicResponse("g-web", "userA"),
    );

    await expect(
      runSosPanic({
        vaultOwnerToken: "tok",
        recipients: [makeRecipient("userA")],
        point: makePoint(),
        prepareEnvelope: vi.fn(
          async () => ({ id: "client-web" }) as never,
        ),
      }),
    ).resolves.toMatchObject({ grantIds: ["g-web"] });
  });

  it("sends a selected fixed message while preserving the SOS share kind", async () => {
    const selected = makeRecipient("userA");
    createGrantMock.mockResolvedValueOnce(makeAtomicResponse("g1", "userA"));

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [selected],
      point: makePoint(),
      note: "Come get me",
      prepareEnvelope: vi.fn(async () => ({ id: "client-envelope" }) as never),
    });

    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "tok",
        recipientUserId: "userA",
        recipientKeyId: "key-userA",
        durationHours: 8,
        reason: "Come get me",
        shareKind: "sos",
        locationMode: "precise",
      }),
    );
  });

  it("forwards a trimmed custom short message while preserving the SOS share kind", async () => {
    const selected = makeRecipient("userA");
    createGrantMock.mockResolvedValueOnce(makeAtomicResponse("g1", "userA"));

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [selected],
      point: makePoint(),
      note: "  Meet me by the north entrance.  ",
      prepareEnvelope: vi.fn(async () => ({ id: "client-envelope" }) as never),
    });

    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "tok",
        recipientUserId: "userA",
        recipientKeyId: "key-userA",
        durationHours: 8,
        reason: "Meet me by the north entrance.",
        shareKind: "sos",
        locationMode: "precise",
      }),
    );
  });

  it("rejects an over-limit message before creating or publishing a grant", async () => {
    const prepareEnvelope = vi.fn();

    const error = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [makeRecipient("userA")],
      point: makePoint(),
      note: "a".repeat(141),
      prepareEnvelope,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SosPanicError);
    expect(error).toMatchObject({
      message: "character limit exceed",
      partialIncident: null,
    });
    expect(createGrantMock).not.toHaveBeenCalled();
    expect(prepareEnvelope).not.toHaveBeenCalled();
    expect(saveSosIncidentMock).not.toHaveBeenCalled();
  });

  it("prepares one encrypted envelope per recipient before each atomic commit", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA"))
      .mockResolvedValueOnce(makeAtomicResponse("g2", "userB"));
    const prepareEnvelope = vi.fn(
      async (recipient) => ({ id: `client-${recipient.userId}` }) as never,
    );
    const point = makePoint();

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point,
      prepareEnvelope,
    });

    expect(prepareEnvelope).toHaveBeenCalledTimes(2);
    expect(prepareEnvelope).toHaveBeenNthCalledWith(1, rA, point);
    expect(prepareEnvelope).toHaveBeenNthCalledWith(2, rB, point);
  });

  it("keeps the successful SOS grant when another recipient's envelope preparation fails", async () => {
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock.mockResolvedValueOnce(makeAtomicResponse("g1", "userA"));

    let prepareCallCount = 0;
    const prepareEnvelope = vi.fn().mockImplementation(async () => {
      prepareCallCount += 1;
      if (prepareCallCount === 2) {
        throw new Error("encryption error on 2nd recipient");
      }
      return { id: "client-userA" } as never;
    });

    const incident = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      prepareEnvelope,
    });

    // Only the first atomic grant exists. The second recipient never receives
    // an empty permission because envelope preparation happened first.
    expect(incident.grantIds).toEqual(["g1"]);
    expect(createGrantMock).toHaveBeenCalledTimes(1);

    expect(saveSosIncidentMock).toHaveBeenCalledTimes(1);
    const savedIncident = saveSosIncidentMock.mock.calls[0][0];
    expect(savedIncident.grantIds).toEqual(["g1"]);
  });

  it("returns an incident with all grant ids and a startedAt ISO string", async () => {
    const rA = makeRecipient("userA");
    createGrantMock.mockResolvedValueOnce(makeAtomicResponse("g1", "userA"));
    const prepareEnvelope = vi.fn(
      async () => ({ id: "client-envelope" }) as never,
    );

    const incident = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA],
      point: makePoint(),
      prepareEnvelope,
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
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA"))
      .mockResolvedValueOnce(makeAtomicResponse("g2", "userB"));
    const prepareEnvelope = vi.fn(
      async () => ({ id: "client-envelope" }) as never,
    );

    await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      prepareEnvelope,
    });

    expect(saveSosIncidentMock).toHaveBeenCalledTimes(1);
    const saved = saveSosIncidentMock.mock.calls[0][0];
    expect(saved.grantIds).toEqual(["g1", "g2"]);
  });

  it("does not persist an incident when the first atomic commit fails", async () => {
    const rA = makeRecipient("userA");
    createGrantMock.mockRejectedValueOnce(new Error("server error"));
    const prepareEnvelope = vi.fn(
      async () => ({ id: "client-envelope" }) as never,
    );

    const err = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA],
      point: makePoint(),
      prepareEnvelope,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SosPanicError);
    expect((err as SosPanicError).message).toBe("server error");
    expect((err as SosPanicError).partialIncident).toBeNull();
    expect(saveSosIncidentMock).not.toHaveBeenCalled();
    expect(prepareEnvelope).toHaveBeenCalledTimes(1);
  });

  it("uses one valid startedAt timestamp for a partial multi-recipient success", async () => {
    // startedAt is captured once before the try — both paths must use it.
    const rA = makeRecipient("userA");
    const rB = makeRecipient("userB");
    createGrantMock
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA"))
      .mockRejectedValueOnce(new Error("fail"));
    const prepareEnvelope = vi.fn(
      async () => ({ id: "client-envelope" }) as never,
    );

    const incident = await runSosPanic({
      vaultOwnerToken: "tok",
      recipients: [rA, rB],
      point: makePoint(),
      prepareEnvelope,
    });

    expect(incident.grantIds).toEqual(["g1"]);
    // startedAt must be a valid ISO string (not two different clock readings)
    expect(typeof incident.startedAt).toBe("string");
    expect(new Date(incident.startedAt).toString()).not.toBe("Invalid Date");
  });
});
