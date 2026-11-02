import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptEnvelopeWithPrivateKey,
  encryptSliceForRecipient,
  ensureMarketplaceRecipientKey,
  decryptMarketplaceEnvelope,
  type MarketplaceEncryptedEnvelope,
} from "@/lib/one-marketplace/encryption";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("times out an unresponsive key store without poisoning the next setup attempt", async () => {
  vi.useFakeTimers();
  const open = vi.fn(() => ({}));
  vi.stubGlobal("indexedDB", { open });
  const first = expect(ensureMarketplaceRecipientKey("stalled-requester")).rejects.toThrow("did not respond");
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  const retry = expect(ensureMarketplaceRecipientKey("stalled-requester")).rejects.toThrow("did not respond");
  await vi.advanceTimersByTimeAsync(5_000);
  await retry;
  expect(open).toHaveBeenCalledTimes(2);
});

it("preserves the one device key across simultaneous setup and refuses storage failure", async () => {
  const records = new Map<string, unknown>();
  let failRead = false;
  let writes = 0;
  vi.stubGlobal("indexedDB", { open: () => {
    const request: Record<string, unknown> = {};
    const database = { close() {}, transaction: () => {
      const transaction: Record<string, unknown> = {};
      transaction.objectStore = () => ({
        get: (id: string) => {
          const read: Record<string, unknown> = {};
          setTimeout(() => {
            if (failRead) {
              read.error = new Error("Storage unavailable");
              (read.onerror as (() => void) | undefined)?.();
              (transaction.onabort as (() => void) | undefined)?.();
            } else {
              read.result = records.get(id);
              (read.onsuccess as (() => void) | undefined)?.();
              queueMicrotask(() => (transaction.oncomplete as (() => void) | undefined)?.());
            }
          }, 0);
          return read;
        },
        add: (record: { userId: string }) => { writes++; records.set(record.userId, record); },
      });
      return transaction;
    } };
    queueMicrotask(() => { request.result = database; (request.onsuccess as (() => void) | undefined)?.(); });
    return request;
  } });
  const keys = await Promise.all(Array.from({ length: 5 }, () => ensureMarketplaceRecipientKey("concurrent-requester")));
  expect(new Set(keys.map(key => key.keyId)).size).toBe(1);
  expect(writes).toBe(1);
  const envelope = await encryptSliceForRecipient({ payload: { approved: "synthetic answer" }, recipientKeyId: keys[0]!.keyId, recipientPublicKeyJwk: keys[0]!.publicKeyJwk });
  await expect(decryptMarketplaceEnvelope({ userId: "concurrent-requester", envelope })).resolves.toEqual({ approved: "synthetic answer" });
  failRead = true;
  await expect(ensureMarketplaceRecipientKey("concurrent-requester")).rejects.toThrow("Storage unavailable");
  expect(writes).toBe(1);
});

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
