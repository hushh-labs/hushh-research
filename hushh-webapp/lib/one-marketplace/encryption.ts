/**
 * Marketplace recipient-key crypto — the user-to-user delivery blueprint from
 * One Location (`lib/one-location/encryption.ts`), mirrored for the Information
 * Marketplace so a buyer can receive an encrypted data slice.
 *
 * A buyer publishes an ECDH P-256 public "lock"; the private half never leaves
 * this device (IndexedDB). The seller encrypts a slice against that public key
 * with an ephemeral keypair (ECDH -> AES-256-GCM), so the server only ever
 * relays ciphertext. Kept in a marketplace-scoped IndexedDB store, separate from
 * One Location, so the two systems' keys never collide.
 */

const DB_NAME = "hushh-one-marketplace-keys";
const STORE_NAME = "recipientKeys";
const DB_VERSION = 1;
const ALGORITHM = "ECDH-P256-AES256-GCM" as const;

export type MarketplaceEncryptedEnvelope = {
  algorithm: typeof ALGORITHM;
  recipientKeyId: string;
  ciphertext: string;
  iv: string;
  senderEphemeralPublicKeyJwk: JsonWebKey;
  metadata?: Record<string, unknown>;
};

type StoredRecipientKey = {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  createdAt: string;
};

function requireCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Marketplace encryption requires Web Crypto.");
  }
  return globalThis.crypto;
}

function openKeyDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Marketplace key storage is unavailable on this device.");
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

async function readStoredKey(userId: string): Promise<StoredRecipientKey | null> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(userId);
    request.onerror = () => reject(request.error || new Error("Unable to read key."));
    request.onsuccess = () => resolve((request.result as StoredRecipientKey | undefined) || null);
    tx.oncomplete = () => db.close();
  });
}

async function writeStoredKey(record: StoredRecipientKey): Promise<void> {
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

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
 * Return this device's marketplace recipient key, generating and persisting a
 * fresh ECDH P-256 keypair on first use. Only the public JWK ever leaves the
 * device; the private key stays in IndexedDB. Idempotent per user.
 */
export async function ensureMarketplaceRecipientKey(userId: string): Promise<{
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
  const keyId = await keyFingerprint(publicKeyJwk);
  await writeStoredKey({
    userId,
    keyId,
    publicKeyJwk,
    privateKey: pair.privateKey,
    createdAt: new Date().toISOString(),
  });
  return { keyId, publicKeyJwk, algorithm: ALGORITHM };
}

/**
 * Encrypt a slice payload (any JSON-serializable value) against a buyer's
 * published public key. Pure crypto — no device state — so the seller can call
 * it with only the recipient's public JWK.
 */
export async function encryptSliceForRecipient(params: {
  payload: unknown;
  recipientPublicKeyJwk: JsonWebKey;
  recipientKeyId: string;
  metadata?: Record<string, unknown>;
}): Promise<MarketplaceEncryptedEnvelope> {
  const crypto = requireCrypto();
  const recipientPublicKey = await importPublicKey(params.recipientPublicKeyJwk);
  const ephemeralPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const aesKey = await deriveAesKey(ephemeralPair.privateKey, recipientPublicKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const senderEphemeralPublicKeyJwk = await crypto.subtle.exportKey("jwk", ephemeralPair.publicKey);

  return {
    algorithm: ALGORITHM,
    recipientKeyId: params.recipientKeyId,
    ciphertext: toBase64Url(ciphertext),
    iv: toBase64Url(exactArrayBuffer(iv)),
    senderEphemeralPublicKeyJwk,
    metadata: { plaintext: false, ...(params.metadata ?? {}) },
  };
}

/**
 * Decrypt an envelope given the recipient's private key. Split out from the
 * IndexedDB-backed path so the crypto round-trip is testable without device
 * storage.
 */
export async function decryptEnvelopeWithPrivateKey(
  privateKey: CryptoKey,
  envelope: MarketplaceEncryptedEnvelope,
): Promise<unknown> {
  const senderPublicKey = await importPublicKey(envelope.senderEphemeralPublicKeyJwk);
  const aesKey = await deriveAesKey(privateKey, senderPublicKey, "decrypt");
  const plaintext = await requireCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
    aesKey,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Decrypt an envelope delivered to this device using the buyer's on-device
 * private key. Throws if the envelope was sealed for a different key than the
 * one stored here (e.g. a different browser/device).
 */
export async function decryptMarketplaceEnvelope(params: {
  userId: string;
  envelope: MarketplaceEncryptedEnvelope;
}): Promise<unknown> {
  const stored = await readStoredKey(params.userId);
  if (!stored || stored.keyId !== params.envelope.recipientKeyId) {
    throw new Error("Recipient key unavailable for this delivered slice.");
  }
  return decryptEnvelopeWithPrivateKey(stored.privateKey, params.envelope);
}
