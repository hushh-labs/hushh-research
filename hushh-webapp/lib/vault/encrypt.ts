// lib/vault/encrypt.ts

/**
 * Client-Side Data Encryption
 * 
 * Encrypts data with vault key before sending to server.
 * Uses AES-256-GCM (same as consent-protocol backend).
 */
import { bytesToBase64 } from "@/lib/vault/base64";

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  encoding: 'base64';
  algorithm: 'aes-256-gcm';
}

const VAULT_KEY_HEX_LENGTH = 64; // AES-256 needs 32 bytes = 64 hex chars
const VAULT_KEY_HEX_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Validate a hex-encoded AES-256 vault key.
 *
 * Throws a clear error for malformed input rather than silently:
 *   - Throwing a cryptic `Cannot read properties of null` (empty string)
 *   - Producing a wrong-sized key from odd-length hex
 *   - Coercing non-hex chars to `0` bytes — which silently uses an
 *     all-zero key, equivalent to no encryption.
 *
 * Exported so other vault code can pre-validate keys before passing them
 * around (e.g., before storing a derived key, before crossing a boundary).
 */
export function validateVaultKeyHex(vaultKeyHex: unknown): asserts vaultKeyHex is string {
  if (typeof vaultKeyHex !== "string") {
    throw new TypeError(
      `Vault key must be a string, got ${vaultKeyHex === null ? "null" : typeof vaultKeyHex}`
    );
  }
  if (vaultKeyHex.length !== VAULT_KEY_HEX_LENGTH) {
    throw new RangeError(
      `Vault key must be exactly ${VAULT_KEY_HEX_LENGTH} hex characters (256 bits); got ${vaultKeyHex.length}`
    );
  }
  if (!VAULT_KEY_HEX_REGEX.test(vaultKeyHex)) {
    throw new RangeError(
      "Vault key must contain only hexadecimal characters (0-9, a-f, A-F)"
    );
  }
}

export async function encryptData(
  plaintext: string,
  vaultKeyHex: string
): Promise<EncryptedPayload> {
  validateVaultKeyHex(vaultKeyHex);
  const keyBytes = new Uint8Array(
    vaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  const ciphertext = new Uint8Array(encrypted.slice(0, -16));
  const tag = new Uint8Array(encrypted.slice(-16));

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    encoding: "base64",
    algorithm: "aes-256-gcm"
  };
}

// Helper to safely decode Base64 strings (handles URL-safe and padding)
function safeBase64Decode(str: string): Uint8Array {
  // 1. Convert Base64URL to Base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  
  // 2. Add padding if missing
  while (base64.length % 4) {
    base64 += '=';
  }

  // 3. Decode
  try {
    const binaryString = atob(base64);
    return Uint8Array.from(binaryString, c => c.charCodeAt(0));
  } catch (_e) {
    console.error("Failed to decode Base64 string");
    throw new Error("Invalid Base64 string format");
  }
}

export async function decryptData(
  payload: EncryptedPayload,
  vaultKeyHex: string
): Promise<string> {
  validateVaultKeyHex(vaultKeyHex);
  const keyBytes = new Uint8Array(
    vaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Use safe decoder
  const ciphertext = safeBase64Decode(payload.ciphertext);
  const tag = safeBase64Decode(payload.tag);
  const iv = safeBase64Decode(payload.iv);

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    combined as any
  );

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}
