// @vitest-environment jsdom
/**
 * Tests for the sos_panic branch in runLocationDirective.
 * Mock setup mirrors specialist-directive-runtime.test.ts but extends
 * OneLocationService with the additional methods needed for SOS.
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
      capturedAt: "2026-07-03T10:00:00.000Z",
      sourcePlatform: "web",
    })),
    getState: vi.fn(),
    storeEnvelope: vi.fn(async () => ({ ok: true })),
    createGrant: vi.fn(),
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
// Helpers
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

function makeGrant(id: string, recipientUserId: string) {
  return {
    id,
    ownerUserId: "me",
    recipientUserId,
    recipientKeyId: `key-${recipientUserId}`,
    status: "active",
    consentScope: "location",
    capabilityScopes: [],
    durationHours: 8,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLocationDirective sos_panic", () => {
  const createGrantMock = vi.mocked(OneLocationService.createGrant);
  const getStateMock = vi.mocked(OneLocationService.getState);
  const storeEnvelopeMock = vi.mocked(OneLocationService.storeEnvelope);
  const encryptMock = vi.mocked(encryptLocationForRecipient);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls createGrant with reason:'sos_panic' and durationHours 8 ONLY for connected+ready recipients, stores one envelope per recipient, returns status:'completed'", async () => {
    // "me" is connected to userA and userB (both share-ready)
    // userC is in the recipients list but NOT a network connection — must be excluded
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
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "sos-act-1", type: "sos_panic", summary: "SOS activated" },
      },
      "vault-token",
      "me",
    );

    // Only 2 grants — not 3 (userC is excluded)
    expect(createGrantMock).toHaveBeenCalledTimes(2);
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        recipientUserId: "userA",
        recipientKeyId: "key-userA",
        durationHours: 8,
        reason: "sos_panic",
      }),
    );
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        recipientUserId: "userB",
        recipientKeyId: "key-userB",
        durationHours: 8,
        reason: "sos_panic",
      }),
    );

    // One encryption + one envelope store per recipient
    expect(encryptMock).toHaveBeenCalledTimes(2);
    expect(storeEnvelopeMock).toHaveBeenCalledTimes(2);
    expect(storeEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ vaultOwnerToken: "vault-token", grantId: "g1" }),
    );
    expect(storeEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ vaultOwnerToken: "vault-token", grantId: "g2" }),
    );

    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "sos-act-1",
      type: "sos_panic",
      status: "completed",
    });
  });

  it("returns status:'cancelled' and does NOT call createGrant when there are no ready connected recipients", async () => {
    // No network connections at all
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [
          { userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC" } },
        ],
        [], // no connections
      ),
    );

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "sos-act-2", type: "sos_panic", summary: "SOS" },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).not.toHaveBeenCalled();
    expect(encryptMock).not.toHaveBeenCalled();
    expect(storeEnvelopeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "sos-act-2",
      type: "sos_panic",
      status: "cancelled",
    });
  });

  it("returns status:'cancelled' when connected recipients exist but none are share-ready (no keyId/publicKeyJwk)", async () => {
    // userA is connected but NOT share-ready (canReceiveLocation false)
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [
          {
            userId: "userA",
            keyId: "key-userA",
            publicKeyJwk: { kty: "EC" },
            canReceiveLocation: false,
          },
        ],
        [
          { id: "c1", userAId: "me", userBId: "userA", status: "active", inviterUserId: "me", inviteeUserId: "userA" },
        ],
      ),
    );

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "sos-act-3", type: "sos_panic", summary: "SOS" },
      },
      "vault-token",
      "me",
    );

    expect(createGrantMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "cancelled" });
  });

  it("works correctly when currentUserId is null (stateless runtime) — adds both sides of every active connection", async () => {
    // When myUserId is null, membership-by-both-sides ensures userA and userB
    // (who are connected to each other) are both in the connected set — so
    // if they appear in recipients they will be alerted.
    getStateMock.mockResolvedValueOnce(
      makeStateWithRecipients(
        [
          { userId: "userA", keyId: "key-userA", publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" } },
          { userId: "userB", keyId: "key-userB", publicKeyJwk: { kty: "EC", crv: "P-256", x: "cc", y: "dd" } },
        ],
        [
          { id: "c1", userAId: "userA", userBId: "userB", status: "active", inviterUserId: "userA", inviteeUserId: "userB" },
        ],
      ),
    );

    createGrantMock
      .mockResolvedValueOnce(makeGrant("g1", "userA"))
      .mockResolvedValueOnce(makeGrant("g2", "userB"));

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "sos-act-4", type: "sos_panic", summary: "SOS" },
      },
      "vault-token",
      null, // null currentUserId
    );

    // Both recipients should be included since both sides of the connection are added
    expect(createGrantMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "completed" });
  });
});
