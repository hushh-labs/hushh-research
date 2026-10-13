// lib/vault/export-encrypt.ts

/**
 * Export Encryption for Consent-Based Data Access
 *
 * When user approves a consent request:
 * 1. Data is decrypted with vault key (client-side)
 * 2. A random export key is generated on device
 * 3. Data is re-encrypted with the export key
 * 4. The export key is wrapped to the connector public key
 *
 * This maintains zero-knowledge: server never sees plaintext or a plaintext export key.
 */
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

export type WrappedExportKeyBundle = {
  wrappedExportKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  senderPublicKey: string;
  wrappingAlg: string;
  connectorKeyId?: string;
};

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Generate a random 256-bit (32-byte) export key
 */
export async function generateExportKey(): Promise<string> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(keyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypt data with an export key for consent-based access
 */
export async function encryptForExport(
  plaintext: string,
  exportKeyHex: string
): Promise<{
  ciphertext: string;
  iv: string;
  tag: string;
}> {
  const keyBytes = hexToBytes(exportKeyHex);

  // Import as AES-GCM key
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );

  // Split ciphertext and tag (last 16 bytes is auth tag)
  const ciphertext = new Uint8Array(encrypted.slice(0, -16));
  const tag = new Uint8Array(encrypted.slice(-16));

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
  };
}

/**
 * Decrypt export-encrypted data (for testing/verification)
 */
export async function decryptExport(
  ciphertext: string,
  iv: string,
  tag: string,
  exportKeyHex: string
): Promise<string> {
  const keyBytes = hexToBytes(exportKeyHex);

  // Import as AES-GCM key
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Decode base64
  const ciphertextBytes = base64ToBytes(ciphertext);
  const ivBytes = base64ToBytes(iv);
  const tagBytes = base64ToBytes(tag);

  // Combine ciphertext and tag for decryption
  const combined = new Uint8Array(ciphertextBytes.length + tagBytes.length);
  combined.set(ciphertextBytes);
  combined.set(tagBytes, ciphertextBytes.length);

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
    key,
    toArrayBuffer(combined)
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function deriveWrappingKey(params: {
  connectorPublicKey: string;
  senderKeyPair?: CryptoKeyPair;
}): Promise<{ wrappingKey: CryptoKey; senderPublicKey: string }> {
  const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
  const senderKeyPair =
    params.senderKeyPair ||
    (await crypto.subtle.generateKey(algorithm, true, ["deriveBits"])) as CryptoKeyPair;

  const connectorPublicKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(params.connectorPublicKey)),
    algorithm,
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: connectorPublicKey } as unknown as AlgorithmIdentifier,
    senderKeyPair.privateKey,
    256
  );
  const derivedBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", sharedSecret));
  const wrappingKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(derivedBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const senderPublicKey = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", senderKeyPair.publicKey))
  );
  return { wrappingKey, senderPublicKey };
}

export async function wrapExportKeyForConnector(params: {
  exportKeyHex: string;
  connectorPublicKey: string;
  connectorKeyId?: string;
}): Promise<WrappedExportKeyBundle> {
  const { wrappingKey, senderPublicKey } = await deriveWrappingKey({
    connectorPublicKey: params.connectorPublicKey,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    toArrayBuffer(hexToBytes(params.exportKeyHex))
  );
  const wrappedBytes = new Uint8Array(wrapped);
  const ciphertext = wrappedBytes.slice(0, -16);
  const tag = wrappedBytes.slice(-16);
  return {
    wrappedExportKey: bytesToBase64(ciphertext),
    wrappedKeyIv: bytesToBase64(iv),
    wrappedKeyTag: bytesToBase64(tag),
    senderPublicKey,
    wrappingAlg: "X25519-AES256-GCM",
    connectorKeyId: params.connectorKeyId,
  };
}
