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
import { sealChatMessage, openChatContent, openChatImage, type ChatMessage } from "@/lib/circle-chat/crypto";

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
  it("seals circle text and images for exactly the roster, authenticates context, and restores on another device", async () => {
    const alice = await ensureVaultSyncedRecipientKey({ userId: "chat-alice", vaultKey: VAULT_KEY, remoteBackup: null });
    const bob = await ensureLocationRecipientKey("chat-bob");
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const file = new File([png], "private-family.png", { type: "image/png" });
    const circle = crypto.randomUUID();
    const sealed = await sealChatMessage({ circleId: circle, userId: "chat-alice", rosterVersion: "v1", text: "private meeting details", file,
      members: [{ userId: "chat-alice", name: "Alice", ...alice }, { userId: "chat-bob", name: "Bob", ...bob }] });
    expect(JSON.stringify(sealed)).not.toContain("meeting details");
    expect(JSON.stringify(sealed)).not.toContain("private-family.png");
    const message: ChatMessage = { id: crypto.randomUUID(), sequence: 1, senderUserId: "chat-alice", senderName: "Alice", createdAt: new Date().toISOString(),
      ...sealed, hasImage: true, envelope: sealed.recipients.find((r) => r.userId === "chat-bob")!.envelope };
    expect(await openChatContent(circle, "chat-bob", message)).toEqual({ text: "private meeting details", image: { type: "image/png", name: "private-family.png" } });
    const blob = await openChatImage(circle, "chat-bob", message, { ciphertext: sealed.imageCiphertext!, iv: sealed.imageIv! }, "image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    await expect(openChatContent(crypto.randomUUID(), "chat-bob", message)).rejects.toThrow();
    await expect(openChatContent(circle, "outsider", message)).rejects.toThrow();
    await expect(openChatContent(circle, "chat-bob", { ...message, senderUserId: "forged-author" })).rejects.toThrow();
    await expect(openChatImage(circle, "chat-bob", message, { ciphertext: sealed.ciphertext, iv: sealed.iv }, "image/png")).rejects.toThrow();
    // Recover the same recipient key after losing every device-local store.
    keychainStore.clear(); await wipeIndexedDb();
    await ensureVaultSyncedRecipientKey({ userId: "chat-alice", vaultKey: VAULT_KEY,
      remoteBackup: { ...alice, encryptedPrivateKeyJwk: alice.encryptedPrivateKeyJwk } as OneLocationMyRecipientKey, strictRecovery: true });
    expect((await openChatContent(circle, "chat-alice", { ...message, envelope: sealed.recipients[0]!.envelope })).text).toBe("private meeting details");
    const rotated = await ensureVaultSyncedRecipientKey({ userId: "rotated-key-holder", vaultKey: VAULT_KEY, remoteBackup: null });
    await ensureVaultSyncedRecipientKey({ userId: "chat-alice", vaultKey: VAULT_KEY, remoteBackup: { ...rotated, keyAlgorithm: rotated.algorithm } });
    const historical = { ...alice, keyAlgorithm: alice.algorithm } as OneLocationMyRecipientKey;
    // A different current key must not discard an accessible historical backup.
    const old = { ...message, envelope: sealed.recipients[0]!.envelope };
    expect((await openChatContent(circle, "chat-alice", old, { vaultKey: VAULT_KEY, remoteBackup: historical })).text).toBe("private meeting details");
  });

  it("refuses to rotate a chat key when remote recovery fails, and rejects active image formats", async () => {
    const key = await ensureVaultSyncedRecipientKey({ userId: "strict-chat", vaultKey: VAULT_KEY, remoteBackup: null });
    const backup = { ...key, encryptedPrivateKeyJwk: key.encryptedPrivateKeyJwk } as OneLocationMyRecipientKey;
    keychainStore.clear(); await wipeIndexedDb();
    await expect(ensureVaultSyncedRecipientKey({ userId: "strict-chat", vaultKey: OTHER_VAULT_KEY, remoteBackup: backup, strictRecovery: true })).rejects.toThrow();
    const restored = await ensureVaultSyncedRecipientKey({ userId: "strict-chat", vaultKey: VAULT_KEY, remoteBackup: backup, strictRecovery: true });
    expect(restored.keyId).toBe(key.keyId);
    await expect(sealChatMessage({ circleId: crypto.randomUUID(), userId: "strict-chat", rosterVersion: "v", text: "", file: new File(["<svg onload='x()'></svg>"], "fake.png", { type: "image/png" }),
      members: [{ userId: "strict-chat", name: "Me", ...restored }] })).rejects.toThrow("JPEG, PNG");
  });

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
