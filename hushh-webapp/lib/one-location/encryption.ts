import { HushhKeychain } from "@/lib/capacitor";
import { isNative } from "@/lib/capacitor/platform";
import { decryptData, encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";
import type {
  OneLocationEncryptedEnvelope,
  OneLocationEncryptedPrivateKey,
  OneLocationMyRecipientKey,
  PlainLocationPoint,
} from "@/lib/one-location/types";

const DB_NAME = "hushh-one-location-keys";
const STORE_NAME = "recipientKeys";
const DB_VERSION = 1;
const ALGORITHM = "ECDH-P256-AES256-GCM" as const;

/**
 * Thrown when the recipient's on-device key can't decrypt an envelope — either
 * it's absent or its keyId no longer matches what the sender encrypted for.
 * Exported so the UI can detect this specific failure and self-heal (re-register
 * the current key + prompt the sender to re-share) instead of showing a raw
 * crypto error. See `app/one/location/page.tsx` and the redesign chat handler.
 */
export const RECIPIENT_KEY_UNAVAILABLE_MESSAGE =
  "Recipient key unavailable for this location share.";

/**
 * The recipient's ECDH private key lives primarily in IndexedDB, but on iOS the
 * app runs under a custom WKWebView scheme (`iosScheme: "App"`) where IndexedDB
 * is evicted / not reliably persisted across launches. Losing the key rotates
 * the keyId and permanently poisons in-flight grants (the recipient can no
 * longer decrypt, and the sender's publishes are rejected as a key mismatch).
 * To prevent that, we mirror the key into the durable native Keychain and
 * restore it — with the SAME keyId — whenever IndexedDB comes up empty.
 */
const KEYCHAIN_KEY_PREFIX = "one_location_recipient_key";

function keychainBackupKey(userId: string): string {
  return `${KEYCHAIN_KEY_PREFIX}:${userId}`;
}

// Portable, JSON-serializable form persisted in both IndexedDB and the Keychain.
type StoredRecipientRecord = {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk?: JsonWebKey;
  // Legacy records (pre-Keychain-backup) stored the CryptoKey directly.
  privateKey?: CryptoKey;
  algorithm?: string;
  createdAt: string;
};

// A key resolved and ready for ECDH derivation.
type ResolvedRecipientKey = {
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  privateKeyJwk?: JsonWebKey;
  algorithm: string;
  createdAt: string;
};

function requireCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Location encryption requires Web Crypto.");
  }
  return globalThis.crypto;
}

function openKeyDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Location key storage is unavailable on this device.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    request.onerror = () => reject(request.error || new Error("Unable to open key storage."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readIdbRecord(userId: string): Promise<StoredRecipientRecord | null> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(userId);
    request.onerror = () => reject(request.error || new Error("Unable to read key."));
    request.onsuccess = () => resolve((request.result as StoredRecipientRecord | undefined) || null);
    tx.oncomplete = () => db.close();
  });
}

async function writeIdbRecord(record: StoredRecipientRecord): Promise<void> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.onerror = () => reject(tx.error || new Error("Unable to store key."));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

// ---- Durable native backup (iOS Keychain; no-op with in-memory fallback on web) ----

async function readKeychainBackup(userId: string): Promise<StoredRecipientRecord | null> {
  if (!isNative()) return null;
  try {
    const { value } = await HushhKeychain.get({ key: keychainBackupKey(userId) });
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredRecipientRecord;
    if (!parsed?.keyId || !parsed.privateKeyJwk || !parsed.publicKeyJwk) return null;
    return { ...parsed, userId };
  } catch {
    // Keychain read is best-effort; never block decryption on it.
    return null;
  }
}

async function writeKeychainBackup(record: {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  algorithm: string;
  createdAt: string;
}): Promise<void> {
  if (!isNative()) return;
  try {
    await HushhKeychain.set({
      key: keychainBackupKey(record.userId),
      value: JSON.stringify({
        userId: record.userId,
        keyId: record.keyId,
        publicKeyJwk: record.publicKeyJwk,
        privateKeyJwk: record.privateKeyJwk,
        algorithm: record.algorithm,
        createdAt: record.createdAt,
      }),
      // Available after first unlock (survives restarts); no biometric prompt so
      // the silent foreground poll never triggers Face ID.
      accessible: "afterFirstUnlock",
    });
  } catch {
    // Best-effort durability; a failed backup must not break sharing.
  }
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function exactArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function keyFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  const crypto = requireCrypto();
  const payload = JSON.stringify(publicKeyJwk, Object.keys(publicKeyJwk).sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return toBase64Url(digest);
}

async function importPublicKey(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

async function importPrivateKey(privateKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey, usage: KeyUsage) {
  return requireCrypto().subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * Load the recipient's current device key, resolving the private CryptoKey ready
 * for derivation. Order: IndexedDB (fast path) → Keychain (durable restore after
 * eviction, repopulating IndexedDB with the SAME keyId). Legacy IndexedDB records
 * that only hold a CryptoKey are migrated to the portable JWK form + backed up.
 */
async function readStoredKey(userId: string): Promise<ResolvedRecipientKey | null> {
  const idbRecord = await readIdbRecord(userId).catch(() => null);
  if (idbRecord) {
    return resolveFromRecord(userId, idbRecord);
  }

  const backup = await readKeychainBackup(userId);
  if (backup?.privateKeyJwk) {
    const privateKey = await importPrivateKey(backup.privateKeyJwk);
    // Repopulate IndexedDB so the fast path serves subsequent reads.
    await writeIdbRecord({
      userId,
      keyId: backup.keyId,
      publicKeyJwk: backup.publicKeyJwk,
      privateKeyJwk: backup.privateKeyJwk,
      algorithm: backup.algorithm ?? ALGORITHM,
      createdAt: backup.createdAt ?? new Date().toISOString(),
    }).catch(() => {});
    return {
      keyId: backup.keyId,
      publicKeyJwk: backup.publicKeyJwk,
      privateKey,
      privateKeyJwk: backup.privateKeyJwk,
      algorithm: backup.algorithm ?? ALGORITHM,
      createdAt: backup.createdAt ?? new Date().toISOString(),
    };
  }

  return null;
}

async function resolveFromRecord(
  userId: string,
  record: StoredRecipientRecord,
): Promise<ResolvedRecipientKey> {
  const algorithm = record.algorithm ?? ALGORITHM;
  const createdAt = record.createdAt ?? new Date().toISOString();

  // Prefer the portable JWK; fall back to a legacy stored CryptoKey.
  let privateKey: CryptoKey;
  let privateKeyJwk = record.privateKeyJwk;
  if (privateKeyJwk) {
    privateKey = await importPrivateKey(privateKeyJwk);
  } else if (record.privateKey) {
    privateKey = record.privateKey;
    // Migrate legacy records to the portable form so they can be backed up.
    privateKeyJwk = await requireCrypto()
      .subtle.exportKey("jwk", record.privateKey)
      .catch(() => undefined);
    if (privateKeyJwk) {
      await writeIdbRecord({
        userId,
        keyId: record.keyId,
        publicKeyJwk: record.publicKeyJwk,
        privateKeyJwk,
        algorithm,
        createdAt,
      }).catch(() => {});
    }
  } else {
    throw new Error("Stored location key is missing private material.");
  }

  // Opportunistically ensure the durable native backup exists.
  if (privateKeyJwk) {
    await ensureKeychainBackedUp({
      userId,
      keyId: record.keyId,
      publicKeyJwk: record.publicKeyJwk,
      privateKeyJwk,
      algorithm,
      createdAt,
    });
  }

  return {
    keyId: record.keyId,
    publicKeyJwk: record.publicKeyJwk,
    privateKey,
    privateKeyJwk,
    algorithm,
    createdAt,
  };
}

async function ensureKeychainBackedUp(record: {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  algorithm: string;
  createdAt: string;
}): Promise<void> {
  if (!isNative()) return;
  const existing = await readKeychainBackup(record.userId);
  if (existing?.keyId === record.keyId) return;
  await writeKeychainBackup(record);
}

export async function ensureLocationRecipientKey(userId: string): Promise<{
  keyId: string;
  publicKeyJwk: JsonWebKey;
  algorithm: typeof ALGORITHM;
}> {
  const existing = await readStoredKey(userId).catch(() => null);
  if (existing) {
    return {
      keyId: existing.keyId,
      publicKeyJwk: existing.publicKeyJwk,
      algorithm: ALGORITHM,
    };
  }

  const crypto = requireCrypto();
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const keyId = await keyFingerprint(publicKeyJwk);
  const createdAt = new Date().toISOString();

  await writeIdbRecord({
    userId,
    keyId,
    publicKeyJwk,
    privateKeyJwk,
    algorithm: ALGORITHM,
    createdAt,
  });
  await writeKeychainBackup({
    userId,
    keyId,
    publicKeyJwk,
    privateKeyJwk,
    algorithm: ALGORITHM,
    createdAt,
  });

  return { keyId, publicKeyJwk, algorithm: ALGORITHM };
}

// ---- Cross-device vault-synced key (private key encrypted with the vault key) ----
//
// The recipient's private key is encrypted with the user's `vaultKey` (a single
// AES-256 key identical on every device after unlock) and stored server-side as an
// opaque blob. Any device the user signs into fetches that blob, decrypts it, and
// holds the SAME keypair — so a share encrypted for one stable keyId decrypts on all
// of the user's devices. Reuses `lib/vault/encrypt` (the same crypto PKM uses).

function toEncryptedPrivateKey(payload: EncryptedPayload): OneLocationEncryptedPrivateKey {
  return {
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    tag: payload.tag,
    algorithm: payload.algorithm,
  };
}

function toEncryptedPayload(blob: OneLocationEncryptedPrivateKey): EncryptedPayload {
  return {
    ciphertext: blob.ciphertext,
    iv: blob.iv,
    tag: blob.tag,
    encoding: "base64",
    algorithm: (blob.algorithm as "aes-256-gcm") || "aes-256-gcm",
  };
}

async function encryptPrivateKeyForVault(
  privateKeyJwk: JsonWebKey,
  vaultKey: string,
): Promise<OneLocationEncryptedPrivateKey> {
  return toEncryptedPrivateKey(await encryptData(JSON.stringify(privateKeyJwk), vaultKey));
}

async function decryptPrivateKeyFromVault(
  blob: OneLocationEncryptedPrivateKey,
  vaultKey: string,
): Promise<JsonWebKey> {
  const decrypted = await decryptData(toEncryptedPayload(blob), vaultKey);
  return JSON.parse(decrypted) as JsonWebKey;
}

async function cacheKeyLocally(record: {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  algorithm: string;
  createdAt: string;
}): Promise<void> {
  await writeIdbRecord(record).catch(() => {});
  await writeKeychainBackup(record);
}

export type VaultSyncedRecipientKey = {
  keyId: string;
  publicKeyJwk: JsonWebKey;
  algorithm: string;
  encryptedPrivateKeyJwk: OneLocationEncryptedPrivateKey;
  // True when the server should be (re)registered with this key/blob — i.e. we
  // generated a new key or need to backfill the blob for other devices.
  needsRegister: boolean;
};

/**
 * Resolve the ONE recipient keypair shared across all of the user's devices.
 * Precedence (converges every device to a single stable keyId):
 *   1. Server vault-synced blob → decrypt with vaultKey, adopt it, cache locally.
 *   2. Local device key → keep it, and produce a blob to backfill the server.
 *   3. Nothing anywhere → generate a fresh keypair, cache + produce a blob.
 * The caller registers the result when `needsRegister` is true.
 */
export async function ensureVaultSyncedRecipientKey(params: {
  userId: string;
  vaultKey: string;
  remoteBackup?: OneLocationMyRecipientKey | null;
}): Promise<VaultSyncedRecipientKey> {
  const { userId, vaultKey } = params;
  const remote = params.remoteBackup;

  // 1. Server holds a vault-synced key → it is the source of truth. Adopt it so
  //    every device converges to the same keypair.
  if (remote?.encryptedPrivateKeyJwk && remote.keyId && remote.publicKeyJwk) {
    try {
      const privateKeyJwk = await decryptPrivateKeyFromVault(
        remote.encryptedPrivateKeyJwk,
        vaultKey,
      );
      const algorithm = remote.keyAlgorithm || ALGORITHM;
      const createdAt = remote.keyRegisteredAt ?? new Date().toISOString();
      await cacheKeyLocally({
        userId,
        keyId: remote.keyId,
        publicKeyJwk: remote.publicKeyJwk,
        privateKeyJwk,
        algorithm,
        createdAt,
      });
      return {
        keyId: remote.keyId,
        publicKeyJwk: remote.publicKeyJwk,
        algorithm,
        encryptedPrivateKeyJwk: remote.encryptedPrivateKeyJwk,
        needsRegister: false,
      };
    } catch {
      // Blob undecryptable (shouldn't happen for the same user) → fall through.
    }
  }

  // 2. This device already has a key → keep it and backfill the server blob.
  const local = await readStoredKey(userId).catch(() => null);
  if (local?.privateKeyJwk) {
    const encryptedPrivateKeyJwk = await encryptPrivateKeyForVault(
      local.privateKeyJwk,
      vaultKey,
    );
    return {
      keyId: local.keyId,
      publicKeyJwk: local.publicKeyJwk,
      algorithm: local.algorithm,
      encryptedPrivateKeyJwk,
      needsRegister: true,
    };
  }

  // 3. Nothing anywhere → generate a fresh vault-synced keypair.
  const crypto = requireCrypto();
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const keyId = await keyFingerprint(publicKeyJwk);
  const createdAt = new Date().toISOString();
  await cacheKeyLocally({
    userId,
    keyId,
    publicKeyJwk,
    privateKeyJwk,
    algorithm: ALGORITHM,
    createdAt,
  });
  const encryptedPrivateKeyJwk = await encryptPrivateKeyForVault(privateKeyJwk, vaultKey);
  return {
    keyId,
    publicKeyJwk,
    algorithm: ALGORITHM,
    encryptedPrivateKeyJwk,
    needsRegister: true,
  };
}

export async function encryptLocationForRecipient(params: {
  point: PlainLocationPoint;
  recipientPublicKeyJwk: JsonWebKey;
  recipientKeyId: string;
}): Promise<OneLocationEncryptedEnvelope> {
  const crypto = requireCrypto();
  const recipientPublicKey = await importPublicKey(params.recipientPublicKeyJwk);
  const ephemeralPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const aesKey = await deriveAesKey(ephemeralPair.privateKey, recipientPublicKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(params.point));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const senderEphemeralPublicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    ephemeralPair.publicKey,
  );

  return {
    algorithm: ALGORITHM,
    recipientKeyId: params.recipientKeyId,
    ciphertext: toBase64Url(ciphertext),
    iv: toBase64Url(exactArrayBuffer(iv)),
    senderEphemeralPublicKeyJwk,
    capturedAt: params.point.capturedAt,
    sourcePlatform: params.point.sourcePlatform,
    metadata: {
      payload: "coordinate_envelope",
      plaintext: false,
    },
  };
}

export async function decryptLocationEnvelope(params: {
  userId: string;
  envelope: OneLocationEncryptedEnvelope;
}): Promise<PlainLocationPoint> {
  const stored = await readStoredKey(params.userId);
  if (!stored || stored.keyId !== params.envelope.recipientKeyId) {
    throw new Error(RECIPIENT_KEY_UNAVAILABLE_MESSAGE);
  }
  const senderPublicKey = await importPublicKey(params.envelope.senderEphemeralPublicKeyJwk);
  const aesKey = await deriveAesKey(stored.privateKey, senderPublicKey, "decrypt");
  const plaintext = await requireCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(params.envelope.iv) },
    aesKey,
    fromBase64Url(params.envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as PlainLocationPoint;
}

/**
 * Decrypt an envelope using an explicitly-provided recipient private JWK.
 * Exists so cross-language parity tests can decrypt a natively-produced envelope
 * without touching IndexedDB/Keychain. Production code should use
 * `decryptLocationEnvelope`.
 */
export async function decryptLocationEnvelopeWithKey(params: {
  privateKeyJwk: JsonWebKey;
  envelope: OneLocationEncryptedEnvelope;
}): Promise<PlainLocationPoint> {
  const privateKey = await importPrivateKey(params.privateKeyJwk);
  const senderPublicKey = await importPublicKey(
    params.envelope.senderEphemeralPublicKeyJwk,
  );
  const aesKey = await deriveAesKey(privateKey, senderPublicKey, "decrypt");
  const plaintext = await requireCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(params.envelope.iv) },
    aesKey,
    fromBase64Url(params.envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as PlainLocationPoint;
}
