import { describe, expect, it } from "vitest";

import {
  decryptEnvelopeWithPrivateKey,
  encryptSliceForRecipient,
  type MarketplaceEncryptedEnvelope,
} from "@/lib/one-marketplace/encryption";

/**
 * Exercises the real ECDH P-256 -> AES-256-GCM delivery path with the buyer's
 * recipient key, without touching IndexedDB (the storage-backed wrapper is a thin
 * lookup around decryptEnvelopeWithPrivateKey).
 */
async function makeRecipientKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { publicKeyJwk, privateKey: pair.privateKey };
}

describe("marketplace encryption", () => {
  it("round-trips a slice payload for the buyer's recipient key", async () => {
    const { publicKeyJwk, privateKey } = await makeRecipientKeyPair();
    const payload = {
      slice: "financial.holdings",
      rows: [{ symbol: "AAPL", shares: 10 }],
      note: "consent-based delivery",
    };

    const envelope = await encryptSliceForRecipient({
      payload,
      recipientPublicKeyJwk: publicKeyJwk,
      recipientKeyId: "buyer-key-123",
    });

    expect(envelope.algorithm).toBe("ECDH-P256-AES256-GCM");
    expect(envelope.recipientKeyId).toBe("buyer-key-123");
    expect(envelope.metadata).toMatchObject({ plaintext: false });
    // The server only ever relays ciphertext — the plaintext must not leak.
    expect(envelope.ciphertext).not.toContain("AAPL");
    expect(JSON.stringify(envelope)).not.toContain("AAPL");

    const decrypted = await decryptEnvelopeWithPrivateKey(privateKey, envelope);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt an envelope sealed for a different recipient key", async () => {
    const seller = await makeRecipientKeyPair();
    const attacker = await makeRecipientKeyPair();

    const envelope = await encryptSliceForRecipient({
      payload: { secret: true },
      recipientPublicKeyJwk: seller.publicKeyJwk,
      recipientKeyId: "buyer-key-123",
    });

    await expect(
      decryptEnvelopeWithPrivateKey(attacker.privateKey, envelope as MarketplaceEncryptedEnvelope),
    ).rejects.toThrow();
  });
});
