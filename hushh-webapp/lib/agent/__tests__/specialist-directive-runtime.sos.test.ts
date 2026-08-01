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
    smsContactUserIds: recipients.map((recipient) => recipient.userId),
  };
}

function makeAtomicResponse(id: string, recipientUserId: string) {
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
      durationHours: 8,
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

describe("runLocationDirective sos_panic", () => {
  const createGrantMock = vi.mocked(
    OneLocationService.createGrantWithEnvelope,
  );
  const getStateMock = vi.mocked(OneLocationService.getState);
  const encryptMock = vi.mocked(encryptLocationForRecipient);

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("creates grants only for selected, connected, ready SMS contacts", async () => {
    // "me" selected and is connected to userA and userB (both share-ready)
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
      .mockResolvedValueOnce(makeAtomicResponse("g1", "userA"))
      .mockResolvedValueOnce(makeAtomicResponse("g2", "userB"));

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
        shareKind: "sos",
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
        durationHours: 8,
        reason: "sos_panic",
        shareKind: "sos",
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

  it("fails closed when currentUserId is null", async () => {
    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "sos-act-4", type: "sos_panic", summary: "SOS" },
      },
      "vault-token",
      null, // null currentUserId
    );

    expect(getStateMock).not.toHaveBeenCalled();
    expect(createGrantMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      detail: "Sign in again before sharing location.",
    });
  });
});
