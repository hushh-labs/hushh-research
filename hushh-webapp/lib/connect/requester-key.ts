// lib/connect/requester-key.ts

/**
 * On-device X25519 requester key for Connect + granular scope requests.
 *
 * When a person clicks "Connect" and also asks for data scopes, this device
 * publishes a raw X25519 public "lock". The private half never leaves the
 * device (IndexedDB). If the addressee grants a scope, their `handleApprove`
 * wraps that scope's export key to this public key via the proven consent
 * export path (X25519 ECDH -> SHA-256 -> AES-256-GCM, see
 * `lib/vault/export-encrypt.ts`), so the server only ever relays ciphertext.
 *
 * This mirrors `lib/one-marketplace/encryption.ts` (recipient-key blueprint)
 * but uses X25519 raw/pkcs8 keys to stay wire-compatible with the export
 * pipeline, and is kept in a Connect-scoped IndexedDB store so its keys never
 * collide with One Location / Marketplace / KYC connector keys.
 *
 * Zero-knowledge is preserved end to end: the backend never sees a plaintext
 * scope value or a plaintext export key.
 */
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { decryptExport } from "@/lib/vault/export-encrypt";

export const CONNECT_REQUESTER_WRAPPING_ALG = "X25519-AES256-GCM" as const;

const DB_NAME = "hushh-one-connect-requester-keys";
const STORE_NAME = "requesterKeys";
const DB_VERSION = 1;

/**
 * A scope export delivered to the requester: the export key wrapped to this
 * device's public key (X25519 -> AES-GCM), plus the scope data encrypted under
 * that export key (AES-GCM). Composed from the owner-side producers
 * `wrapExportKeyForConnector` (key half) and `encryptForExport` (data half).
 */
export type ConnectScopedExportEnvelope = {
  wrappingAlg?: string;
  connectorKeyId?: string;
  // Wrapped export key (X25519 ECDH -> SHA-256 -> AES-256-GCM).
  wrappedExportKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  senderPublicKey: string;
  keyAdditionalData?: string;
  // Scope data encrypted under the export key (AES-256-GCM).
  ciphertext: string;
  iv: string;
  tag: string;
  dataAdditionalData?: string;
};

export type ConnectRequesterKeyHandle = {
  keyId: string;
  publicKey: string;
  wrappingAlg: typeof CONNECT_REQUESTER_WRAPPING_ALG;
};

type StoredRequesterKey = {
  userId: string;
  keyId: string;
  publicKey: string; // base64 raw X25519 public key
  privateKey: CryptoKey; // non-serialized; structured-cloned into IndexedDB
  createdAt: string;
};

function requireCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Connect requester keys require Web Crypto.");
  }
  return globalThis.crypto;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await requireCrypto().subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return bytesToHex(digest);
}

function openKeyDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Connect key storage is unavailable on this device.");
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

async function readStoredKey(userId: string): Promise<StoredRequesterKey | null> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(userId);
    request.onerror = () => reject(request.error || new Error("Unable to read key."));
    request.onsuccess = () => resolve((request.result as StoredRequesterKey | undefined) || null);
    tx.oncomplete = () => db.close();
  });
}

async function writeStoredKey(record: StoredRequesterKey): Promise<void> {
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

/**
 * Return this device's Connect requester key, generating and persisting a fresh
 * X25519 keypair on first use. Only the raw base64 public key ever leaves the
 * device (sent as `requester_public_key` with the connection request); the
 * private key stays in IndexedDB. Idempotent per user.
 */
export async function ensureConnectRequesterKey(
  userId: string,
): Promise<ConnectRequesterKeyHandle> {
  const existing = await readStoredKey(userId).catch(() => null);
  if (existing) {
    return {
      keyId: existing.keyId,
      publicKey: existing.publicKey,
      wrappingAlg: CONNECT_REQUESTER_WRAPPING_ALG,
    };
  }

  const cryptoObj = requireCrypto();
  const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
  const pair = (await cryptoObj.subtle.generateKey(algorithm, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array(
    await cryptoObj.subtle.exportKey("raw", pair.publicKey),
  );
  const publicKey = bytesToBase64(publicKeyBytes);
  const keyId = `connect-req-${(await sha256Hex(publicKeyBytes)).slice(0, 20)}`;
  await writeStoredKey({
    userId,
    keyId,
    publicKey,
    privateKey: pair.privateKey,
    createdAt: new Date().toISOString(),
  });
  return { keyId, publicKey, wrappingAlg: CONNECT_REQUESTER_WRAPPING_ALG };
}

/**
 * Unwrap an export key that was wrapped to this device's public key. Symmetric
 * with `deriveWrappingKey`/`wrapExportKeyForConnector` in
 * `lib/vault/export-encrypt.ts`: import the sender's ephemeral public key,
 * derive the shared secret, hash to an AES-GCM key, and decrypt.
 */
async function unwrapExportKeyWithPrivateKey(
  privateKey: CryptoKey,
  bundle: {
    wrappedExportKey: string;
    wrappedKeyIv: string;
    wrappedKeyTag: string;
    senderPublicKey: string;
    additionalData?: string;
  },
): Promise<string> {
  const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
  const senderPublicKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(bundle.senderPublicKey)),
    algorithm,
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: senderPublicKey } as unknown as AlgorithmIdentifier,
    privateKey,
    256,
  );
  const derivedBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", sharedSecret),
  );
  const wrappingKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(derivedBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertext = base64ToBytes(bundle.wrappedExportKey);
  const tag = base64ToBytes(bundle.wrappedKeyTag);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  const exportKeyBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(base64ToBytes(bundle.wrappedKeyIv)),
        ...(bundle.additionalData
          ? { additionalData: new TextEncoder().encode(bundle.additionalData) }
          : {}),
      },
      wrappingKey,
      toArrayBuffer(sealed),
    ),
  );
  return bytesToHex(exportKeyBytes);
}

/**
 * Decrypt a scoped export given this device's private key. Split out from the
 * IndexedDB-backed path so the crypto round-trip is testable without device
 * storage (mirrors `decryptEnvelopeWithPrivateKey` in the marketplace module).
 */
export async function decryptConnectScopedExportWithPrivateKey(
  privateKey: CryptoKey,
  envelope: ConnectScopedExportEnvelope,
): Promise<string> {
  if (
    envelope.wrappingAlg &&
    envelope.wrappingAlg !== CONNECT_REQUESTER_WRAPPING_ALG
  ) {
    throw new Error(`Unsupported wrapping algorithm: ${envelope.wrappingAlg}`);
  }
  const exportKeyHex = await unwrapExportKeyWithPrivateKey(privateKey, {
    wrappedExportKey: envelope.wrappedExportKey,
    wrappedKeyIv: envelope.wrappedKeyIv,
    wrappedKeyTag: envelope.wrappedKeyTag,
    senderPublicKey: envelope.senderPublicKey,
    additionalData: envelope.keyAdditionalData,
  });
  return decryptExport(
    envelope.ciphertext,
    envelope.iv,
    envelope.tag,
    exportKeyHex,
    envelope.dataAdditionalData
      ? { additionalData: envelope.dataAdditionalData }
      : undefined,
  );
}

/**
 * Decrypt a scoped export delivered to this device using the on-device private
 * key. Throws if this device holds no requester key, or if the export was
 * sealed for a different key (e.g. a different browser/device).
 */
export async function decryptConnectScopedExport(params: {
  userId: string;
  envelope: ConnectScopedExportEnvelope;
}): Promise<string> {
  const stored = await readStoredKey(params.userId);
  if (!stored) {
    throw new Error("Requester key unavailable on this device.");
  }
  if (
    params.envelope.connectorKeyId &&
    params.envelope.connectorKeyId !== stored.keyId
  ) {
    throw new Error("Scoped export was sealed for a different requester key.");
  }
  return decryptConnectScopedExportWithPrivateKey(stored.privateKey, params.envelope);
}
