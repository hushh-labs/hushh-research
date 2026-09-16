// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  indexRecipientsByUserId,
  publishPointToGrants,
} from "@/lib/location/publisher";
import type {
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { ApiError } from "@/lib/services/api-client";

const NOW = Date.parse("2026-09-15T10:00:30.000Z");

const POINT: PlainLocationPoint = {
  latitude: 37.774929,
  longitude: -122.419416,
  accuracyM: 8,
  capturedAt: "2026-09-15T10:00:00.000Z",
  sourcePlatform: "web",
};

function grant(
  id: string,
  recipientUserId: string,
  recipientKeyId: string,
  status = "active",
): OneLocationGrant {
  return {
    id,
    ownerUserId: "owner",
    recipientUserId,
    recipientKeyId,
    status,
    consentScope: "location.live",
    capabilityScopes: [],
    durationHours: 1,
  };
}

function recipient(userId: string, keyId: string | null): OneLocationRecipient {
  return {
    userId,
    displayName: userId,
    phoneVerified: true,
    keyId,
    publicKeyJwk: keyId ? { kty: "EC", crv: "P-256", x: "x", y: "y" } : null,
    keyAlgorithm: "ECDH-P256-AES256-GCM",
    canReceiveLocation: Boolean(keyId),
  };
}

function fakeEncrypt() {
  return vi.fn(
    async (params: { point: PlainLocationPoint; recipientKeyId: string }) => {
      const envelope: OneLocationEncryptedEnvelope = {
        algorithm: "ECDH-P256-AES256-GCM",
        recipientKeyId: params.recipientKeyId,
        ciphertext: `ct:${params.point.latitude},${params.point.longitude}`,
        iv: "iv",
        senderEphemeralPublicKeyJwk: { kty: "EC" },
        capturedAt: params.point.capturedAt,
        sourcePlatform: params.point.sourcePlatform,
        metadata: { payload: "coordinate_envelope", plaintext: false },
      };
      return envelope;
    },
  );
}

describe("publishPointToGrants", () => {
  it("publishes to every active grant with a matching key, once per key", async () => {
    const encrypt = fakeEncrypt();
    const store = vi.fn(async () => ({
      envelope: {} as OneLocationEncryptedEnvelope,
      recipientAlerted: null,
    }));
    const result = await publishPointToGrants({
      point: POINT,
      grants: [
        grant("g1", "alice", "k-alice"),
        grant("g2", "bob", "k-bob"),
        grant("g3", "alice", "k-alice"),
      ],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
        recipient("bob", "k-bob"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt,
      store,
      now: () => NOW,
    });
    expect(result.failures).toEqual([]);
    expect(result.published.map((row) => row.grantId)).toEqual([
      "g1",
      "g2",
      "g3",
    ]);
    expect(result.precision).toBe("precise");
    expect(result.capturedAt).toBe(POINT.capturedAt);
    // Two recipient keys, three grants: two encryptions, three stores.
    expect(encrypt).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledTimes(3);
    const stored = store.mock.calls[0]![0] as {
      grantId: string;
      envelope: OneLocationEncryptedEnvelope;
      vaultOwnerToken: string;
    };
    expect(stored.vaultOwnerToken).toBe("token");
    expect(stored.envelope.publicationContext).toBe("foreground_map_visible");
    expect(stored.envelope.metadata).toMatchObject({
      precision: "precise",
      payload: "coordinate_envelope",
    });
  });

  it("coarsens before encrypting and tags the envelope approximate", async () => {
    const encrypt = fakeEncrypt();
    const store = vi.fn(async () => ({
      envelope: {} as OneLocationEncryptedEnvelope,
      recipientAlerted: null,
    }));
    const result = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "approximate",
      vaultOwnerToken: "token",
      encrypt,
      store,
      now: () => NOW,
    });
    expect(result.published).toHaveLength(1);
    const encrypted = encrypt.mock.calls[0]![0].point;
    expect(encrypted.latitude).toBe(37.77);
    expect(encrypted.longitude).toBe(-122.42);
    expect(encrypted.precision).toBe("approximate");
    const stored = store.mock.calls[0]![0] as {
      envelope: OneLocationEncryptedEnvelope;
    };
    expect(stored.envelope.metadata?.precision).toBe("approximate");
    expect(result.precision).toBe("approximate");
  });

  it("SOS publishes the precise point even with an approximate preference", async () => {
    const encrypt = fakeEncrypt();
    const store = vi.fn(async () => ({
      envelope: {} as OneLocationEncryptedEnvelope,
      recipientAlerted: true,
    }));
    const result = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "approximate",
      sos: true,
      vaultOwnerToken: "token",
      encrypt,
      store,
      now: () => NOW,
    });
    expect(encrypt.mock.calls[0]![0].point.latitude).toBe(POINT.latitude);
    expect(result.precision).toBe("precise");
    expect(result.published[0]?.recipientAlerted).toBe(true);
  });

  it("reports no_recipient_key when the recipient has no key or a different key", async () => {
    const encrypt = fakeEncrypt();
    const store = vi.fn(async () => ({
      envelope: {} as OneLocationEncryptedEnvelope,
      recipientAlerted: null,
    }));
    const result = await publishPointToGrants({
      point: POINT,
      grants: [
        grant("g1", "alice", "k-alice-old"),
        grant("g2", "carol", "k-carol"),
        grant("g3", "dave", "k-dave"),
      ],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice-new"),
        recipient("carol", null),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt,
      store,
      now: () => NOW,
    });
    expect(result.published).toEqual([]);
    expect(result.failures).toEqual([
      { grantId: "g1", code: "no_recipient_key", reason: "key_mismatch" },
      { grantId: "g2", code: "no_recipient_key", reason: "key_missing" },
      { grantId: "g3", code: "no_recipient_key", reason: "key_missing" },
    ]);
    expect(encrypt).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("reports stale_fix for every grant without encrypting when the fix is too old", async () => {
    const encrypt = fakeEncrypt();
    const store = vi.fn();
    const result = await publishPointToGrants({
      point: { ...POINT, capturedAt: "2026-09-15T09:58:00.000Z" },
      grants: [grant("g1", "alice", "k-alice"), grant("g2", "bob", "k-bob")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
        recipient("bob", "k-bob"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt,
      store,
      now: () => NOW,
    });
    expect(result.failures.map((row) => row.code)).toEqual([
      "stale_fix",
      "stale_fix",
    ]);
    expect(encrypt).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("treats an unparsable capturedAt as stale", async () => {
    const result = await publishPointToGrants({
      point: { ...POINT, capturedAt: "not-a-date" },
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: fakeEncrypt(),
      store: vi.fn(),
      now: () => NOW,
    });
    expect(result.failures).toEqual([
      { grantId: "g1", code: "stale_fix", reason: null },
    ]);
  });

  it("maps a 403 / LOCATION_SHARING_OFF store failure to permission_denied and isolates it", async () => {
    const store = vi.fn(async (params: { grantId: string }) => {
      if (params.grantId === "g1") {
        throw new ApiError("Sharing is off", 409, {
          detail: { code: "LOCATION_SHARING_OFF" },
        });
      }
      if (params.grantId === "g2") {
        throw new ApiError("Forbidden", 403, {
          detail: { code: "LOCATION_GRANT_FORBIDDEN" },
        });
      }
      return {
        envelope: {} as OneLocationEncryptedEnvelope,
        recipientAlerted: null,
      };
    });
    const result = await publishPointToGrants({
      point: POINT,
      grants: [
        grant("g1", "alice", "k-alice"),
        grant("g2", "bob", "k-bob"),
        grant("g3", "carol", "k-carol"),
      ],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
        recipient("bob", "k-bob"),
        recipient("carol", "k-carol"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: fakeEncrypt(),
      store,
      now: () => NOW,
    });
    expect(result.published.map((row) => row.grantId)).toEqual(["g3"]);
    expect(result.failures).toEqual([
      {
        grantId: "g1",
        code: "permission_denied",
        reason: "LOCATION_SHARING_OFF",
      },
      {
        grantId: "g2",
        code: "permission_denied",
        reason: "LOCATION_GRANT_FORBIDDEN",
      },
    ]);
  });

  it("maps any other store or encrypt error to store_failed", async () => {
    const store = vi.fn(async () => {
      throw new ApiError("Precision mismatch", 409, {
        detail: { code: "LOCATION_PRECISION_MISMATCH" },
      });
    });
    const failingEncrypt = vi.fn(async () => {
      throw new Error("WebCrypto unavailable");
    });
    const mismatch = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: fakeEncrypt(),
      store,
      now: () => NOW,
    });
    expect(mismatch.failures).toEqual([
      {
        grantId: "g1",
        code: "store_failed",
        reason: "LOCATION_PRECISION_MISMATCH",
      },
    ]);
    const crypto = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: failingEncrypt,
      store: vi.fn(),
      now: () => NOW,
    });
    expect(crypto.failures).toEqual([
      { grantId: "g1", code: "store_failed", reason: "WebCrypto unavailable" },
    ]);
  });

  it("skips a grant that is not active without calling the server", async () => {
    const store = vi.fn(async () => ({
      envelope: {} as OneLocationEncryptedEnvelope,
      recipientAlerted: null,
    }));
    const result = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice", "revoked")],
      recipientsByUserId: indexRecipientsByUserId([
        recipient("alice", "k-alice"),
      ]),
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: fakeEncrypt(),
      store,
      now: () => NOW,
    });
    expect(result.failures).toEqual([
      { grantId: "g1", code: "store_failed", reason: "grant_not_active" },
    ]);
    expect(store).not.toHaveBeenCalled();
  });

  it("accepts a plain record as the recipient lookup", async () => {
    const result = await publishPointToGrants({
      point: POINT,
      grants: [grant("g1", "alice", "k-alice")],
      recipientsByUserId: { alice: recipient("alice", "k-alice") },
      precision: "precise",
      vaultOwnerToken: "token",
      encrypt: fakeEncrypt(),
      store: vi.fn(async () => ({
        envelope: {} as OneLocationEncryptedEnvelope,
        recipientAlerted: null,
      })),
      now: () => NOW,
    });
    expect(result.published).toHaveLength(1);
  });
});
