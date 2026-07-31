// @vitest-environment node
//
// Verifies the One Location recipient key survives IndexedDB loss (the iOS
// WKWebView custom-scheme eviction that poisons live-location shares) by being
// backed up to native storage (HushhKeychain), and that decrypt fails cleanly
// with a detectable message when no matching key exists.
//
// Runs in the `node` environment (not jsdom): the module is pure Web Crypto and
// jsdom hands out cross-realm ArrayBuffers that Node's SubtleCrypto rejects via
// strict instanceof. Node provides globalThis.crypto (subtle) natively.

// fake-indexeddb/auto installs a working `indexedDB` global.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stateful in-memory Keychain mock — the whole point is that it OUTLIVES an
// IndexedDB wipe, mirroring the native iOS Keychain.
const keychainStore = new Map<string, string>();
vi.mock("@/lib/capacitor", () => ({
  HushhKeychain: {
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      keychainStore.set(key, value);
    }),
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: keychainStore.has(key) ? keychainStore.get(key)! : null,
    })),
    delete: vi.fn(async ({ key }: { key: string }) => {
      keychainStore.delete(key);
    }),
  },
}));

// Treat the test environment as native so the Keychain backup path runs.
vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => true,
}));

import {
  RECIPIENT_KEY_UNAVAILABLE_MESSAGE,
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureLocationRecipientKey,
  ensureVaultSyncedRecipientKey,
} from "@/lib/one-location/encryption";
import type {
  OneLocationMyRecipientKey,
  PlainLocationPoint,
} from "@/lib/one-location/types";

// 32-byte vault keys as hex (the format lib/vault/encrypt expects). Same key on
// every device after unlock; a different user/key must NOT decrypt.
const VAULT_KEY = "ab".repeat(32);
const OTHER_VAULT_KEY = "cd".repeat(32);

const USER_ID = "user-abc";

function samplePoint(): PlainLocationPoint {
  return {
    latitude: 37.4219983,
    longitude: -122.084,
    accuracyM: 5,
    capturedAt: "2026-07-07T10:00:00.000Z",
    sourcePlatform: "ios",
  };
}

function wipeIndexedDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("hushh-one-location-keys");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe("one-location encryption durable recipient key", () => {
  beforeEach(async () => {
    keychainStore.clear();
    await wipeIndexedDb();
  });

  afterEach(async () => {
    await wipeIndexedDb();
  });

  it("writes the key to both IndexedDB and the Keychain and is idempotent", async () => {
    const first = await ensureLocationRecipientKey(USER_ID);
    expect(first.keyId).toBeTruthy();
    // Backed up to the durable native store.
    expect(keychainStore.size).toBe(1);

    const second = await ensureLocationRecipientKey(USER_ID);
    expect(second.keyId).toBe(first.keyId);
  });

  it("restores the SAME key from the Keychain after IndexedDB is wiped, so decrypt still works", async () => {
    const key = await ensureLocationRecipientKey(USER_ID);
    const envelope = await encryptLocationForRecipient({
      point: samplePoint(),
      recipientPublicKeyJwk: key.publicKeyJwk,
      recipientKeyId: key.keyId,
    });

    // Simulate the iOS WKWebView eviction that used to poison the share.
    await wipeIndexedDb();

    const point = await decryptLocationEnvelope({ userId: USER_ID, envelope });
    expect(point.latitude).toBeCloseTo(samplePoint().latitude);
    expect(point.longitude).toBeCloseTo(samplePoint().longitude);
  });

  it("keeps a Check-In message inside the recipient-encrypted payload", async () => {
    const key = await ensureLocationRecipientKey(USER_ID);
    const envelope = await encryptLocationForRecipient({
      point: {
        ...samplePoint(),
        checkIn: { message: "Meet me by the event entrance" },
      },
      recipientPublicKeyJwk: key.publicKeyJwk,
      recipientKeyId: key.keyId,
    });

    expect(JSON.stringify(envelope)).not.toContain("event entrance");
    const point = await decryptLocationEnvelope({
      userId: USER_ID,
      envelope,
    });
    expect(point.checkIn?.message).toBe("Meet me by the event entrance");
  });

  it("throws a detectable message when no key exists in either store", async () => {
    const key = await ensureLocationRecipientKey(USER_ID);
    const envelope = await encryptLocationForRecipient({
      point: samplePoint(),
      recipientPublicKeyJwk: key.publicKeyJwk,
      recipientKeyId: key.keyId,
    });

    // Lose BOTH stores — no recovery possible.
    await wipeIndexedDb();
    keychainStore.clear();

    await expect(
      decryptLocationEnvelope({ userId: USER_ID, envelope }),
    ).rejects.toThrow(RECIPIENT_KEY_UNAVAILABLE_MESSAGE);
  });

  it("throws the detectable message when the on-device keyId no longer matches the envelope", async () => {
    const original = await ensureLocationRecipientKey(USER_ID);
    const envelope = await encryptLocationForRecipient({
      point: samplePoint(),
      recipientPublicKeyJwk: original.publicKeyJwk,
      recipientKeyId: original.keyId,
    });

    // Rotate to a brand-new key (both stores gone → regenerated).
    await wipeIndexedDb();
    keychainStore.clear();
    const rotated = await ensureLocationRecipientKey(USER_ID);
    expect(rotated.keyId).not.toBe(original.keyId);

    await expect(
      decryptLocationEnvelope({ userId: USER_ID, envelope }),
    ).rejects.toThrow(RECIPIENT_KEY_UNAVAILABLE_MESSAGE);
  });
});

describe("one-location cross-device vault-synced recipient key", () => {
  beforeEach(async () => {
    keychainStore.clear();
    await wipeIndexedDb();
  });

  afterEach(async () => {
    await wipeIndexedDb();
  });

  function backupFrom(resolved: {
    keyId: string;
    publicKeyJwk: JsonWebKey;
    algorithm: string;
    encryptedPrivateKeyJwk: OneLocationMyRecipientKey["encryptedPrivateKeyJwk"];
  }): OneLocationMyRecipientKey {
    return {
      keyId: resolved.keyId,
      publicKeyJwk: resolved.publicKeyJwk,
      keyAlgorithm: resolved.algorithm,
      encryptedPrivateKeyJwk: resolved.encryptedPrivateKeyJwk,
      keyRegisteredAt: null,
    };
  }

  it("lets a second device recover the SAME keypair from the vault blob and decrypt", async () => {
    // Device A: first-ever provisioning → generates + produces the encrypted blob.
    const deviceA = await ensureVaultSyncedRecipientKey({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
    });
    expect(deviceA.needsRegister).toBe(true);
    const envelope = await encryptLocationForRecipient({
      point: samplePoint(),
      recipientPublicKeyJwk: deviceA.publicKeyJwk,
      recipientKeyId: deviceA.keyId,
    });

    // Device B: fresh device — no local key, but the server has the vault blob.
    await wipeIndexedDb();
    keychainStore.clear();
    const deviceB = await ensureVaultSyncedRecipientKey({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      remoteBackup: backupFrom(deviceA),
    });
    expect(deviceB.keyId).toBe(deviceA.keyId); // same identity across devices
    expect(deviceB.needsRegister).toBe(false); // already synced, no re-upload

    // Device B can now decrypt the share encrypted for the shared key.
    const point = await decryptLocationEnvelope({ userId: USER_ID, envelope });
    expect(point.latitude).toBeCloseTo(samplePoint().latitude);
  });

  it("backfills a vault blob for an existing device-local key without changing the keyId", async () => {
    const local = await ensureLocationRecipientKey(USER_ID); // legacy device-local key
    const resolved = await ensureVaultSyncedRecipientKey({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      remoteBackup: null, // server has no blob yet
    });
    expect(resolved.keyId).toBe(local.keyId); // same key, just now backed up
    expect(resolved.needsRegister).toBe(true); // caller uploads the blob
    expect(resolved.encryptedPrivateKeyJwk.ciphertext).toBeTruthy();
  });

  it("does not adopt a blob it can't decrypt (wrong vault key) — provisions a fresh key instead", async () => {
    const deviceA = await ensureVaultSyncedRecipientKey({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
    });

    await wipeIndexedDb();
    keychainStore.clear();
    const wrongKeyDevice = await ensureVaultSyncedRecipientKey({
      userId: USER_ID,
      vaultKey: OTHER_VAULT_KEY, // cannot decrypt deviceA's blob
      remoteBackup: backupFrom(deviceA),
    });
    expect(wrongKeyDevice.keyId).not.toBe(deviceA.keyId);
    expect(wrongKeyDevice.needsRegister).toBe(true);
  });
});
