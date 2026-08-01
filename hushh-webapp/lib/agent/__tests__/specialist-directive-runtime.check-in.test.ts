// @vitest-environment jsdom
/**
 * Tests for the check_in branch in runLocationDirective.
 * Mirrors specialist-directive-runtime.sos.test.ts exactly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the imports that resolve them
// ---------------------------------------------------------------------------

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: vi.fn(async () => ({
      latitude: 37.77,
      longitude: -122.41,
      capturedAt: "2026-07-06T10:00:00.000Z",
      sourcePlatform: "web",
    })),
    getState: vi.fn(),
    getPermissionState: vi.fn(async () => ({
      state: "granted",
      precise: true,
      background: "foreground-only",
    })),
    createGrantWithEnvelope: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(async () => ({ ciphertext: "x", iv: "y" })),
}));

vi.mock("@/lib/one-location/sos-incident", () => ({
  saveSosIncident: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

// ---------------------------------------------------------------------------
// Helpers (identical to sos.test.ts)
// ---------------------------------------------------------------------------

function makeStateWithRecipients(
  recipients: Array<{
    userId: string;
    keyId: string;
    publicKeyJwk: JsonWebKey;
    canReceiveLocation?: boolean;
  }>,
  networkConnections: Array<{
    id: string;
    userAId: string;
    userBId: string;
    status: string;
    inviterUserId: string;
    inviteeUserId: string;
  }> = [],
) {
  return {
    recipients: recipients.map((r) => ({
      displayName: `User ${r.userId}`,
      phoneVerified: true,
      keyAlgorithm: "ECDH-P256",
      canReceiveLocation: r.canReceiveLocation ?? true,
      ...r,
    })),
    networkConnections,
    ownerGrants: [],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
  };
}

function makeAtomicResponse(
  id: string,
  recipientUserId: string,
  durationHours = 1,
) {
  const envelope = { id: `envelope-${id}` };
  return {
    grant: {
      id,
      ownerUserId: "me",
      recipientUserId,
      recipientKeyId: `key-${recipientUserId}`,
      status: "active",
      consentScope: "location",
      capabilityScopes: [],
      durationHours,
      locationMode: "precise",
      approximateRadiusM: null,
      latestEnvelopeId: envelope.id,
    },
    envelope,
    idempotentReplay: false,
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLocationDirective check_in", () => {
  const createGrantMock = vi.mocked(
    OneLocationService.createGrantWithEnvelope,
  );
  const getStateMock = vi.mocked(OneLocationService.getState);
  const encryptMock = vi.mocked(encryptLocationForRecipient);

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("creates grants with the payload durationHours + note as reason, stores one envelope per recipient, returns status:'completed'", async () => {
    // "me" connected to userA and userB (both share-ready); userC excluded
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [
          { userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" } },
          { userId: "userB", keyId: "key-userB", publicKeyJwk: { kty: "EC", crv: "P-256", x: "cc", y: "dd" } },
          { userId: "userC", keyId: "key-userC", publicKeyJwk: { kty: "EC", crv: "P-256", x: "ee", y: "ff" } },
        ],
        [
          { id: "c1", userAId: "me", userBId: "userA", status: "active", inviterUserId: "me", inviteeUserId: "userA" },
          { id: "c2", userAId: "userB", userBId: "me", status: "active", inviterUserId: "userB", inviteeUserId: "me" },
          // userC has NO connection to "me"
        ],
      ),
    );

    createGrantMock
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA", 3))
      .mockResolvedValueOnce(makeAtomicResponse("g2", "userB", 3));

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: {
          id: "ci-act-1",
          type: "check_in",
          durationHours: 3,
          note: "on my way",
          summary: "Check-in activated",
        },
      },
      "vault-token",
      "me",
    );

    // Only 2 grants — userC is excluded (not a connection)
    expect(createGrantMock).toHaveBeenCalledTimes(2);
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        recipientUserId: "userA",
        recipientKeyId: "key-userA",
        durationHours: 3,
        reason: "on my way",
        shareKind: "check_in",
        locationMode: "precise",
        approximateRadiusM: null,
        envelope: { ciphertext: "x", iv: "y" },
      }),
    );
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        recipientUserId: "userB",
        recipientKeyId: "key-userB",
        durationHours: 3,
        reason: "on my way",
        shareKind: "check_in",
        locationMode: "precise",
        approximateRadiusM: null,
        envelope: { ciphertext: "x", iv: "y" },
      }),
    );

    // One encryption + one atomic grant/envelope commit per recipient.
    expect(encryptMock).toHaveBeenCalledTimes(2);

    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "ci-act-1",
      type: "check_in",
      status: "completed",
    });
  });

  it("defaults durationHours to 1 when payload omits it", async () => {
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [{ userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" } }],
        [{ id: "c1", userAId: "me", userBId: "userA", status: "active", inviterUserId: "me", inviteeUserId: "userA" }],
      ),
    );
    createGrantMock.mockResolvedValueOnce(
      makeAtomicResponse("g1", "userA", 1),
    );

    await runLocationDirective(
      {
        kind: "action",
        payload: { id: "ci-act-default", type: "check_in" },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationHours: 1 }),
    );
  });

  it("uses 'Checking in' as reason when note is absent", async () => {
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [{ userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" } }],
        [{ id: "c1", userAId: "me", userBId: "userA", status: "active", inviterUserId: "me", inviteeUserId: "userA" }],
      ),
    );
    createGrantMock.mockResolvedValueOnce(
      makeAtomicResponse("g1", "userA", 1),
    );

    await runLocationDirective(
      {
        kind: "action",
        payload: { id: "ci-act-no-note", type: "check_in", durationHours: 1 },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Checking in" }),
    );
  });

  it("returns status:'cancelled' and does NOT call createGrant when there are no connected recipients", async () => {
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [{ userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC" } }],
        [], // no connections
      ),
    );

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "ci-act-2", type: "check_in", durationHours: 1, note: "hi" },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).not.toHaveBeenCalled();
    expect(encryptMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "ci-act-2",
      type: "check_in",
      status: "cancelled",
    });
  });

  it("returns status:'cancelled' when connected recipients exist but none are share-ready", async () => {
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [{ userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC" }, canReceiveLocation: false }],
        [{ id: "c1", userAId: "me", userBId: "userA", status: "active", inviterUserId: "me", inviteeUserId: "userA" }],
      ),
    );

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "ci-act-3", type: "check_in", durationHours: 2 },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "cancelled" });
  });
});
