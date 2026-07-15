// lib/vault/passphrase-key.ts
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

/**
 * Passphrase-Based Key Derivation (Fallback)
 *
 * When PRF is not available or fails, we fall back to
 * passphrase-based key derivation using PBKDF2.
 *
 * This is the standard approach used by most password managers
 * (1Password, Bitwarden, etc.) when passkeys aren't available.
 *
 * Bible Compliance:
 *   - Zero-knowledge: Passphrase never leaves device
 *   - Vault encryption: AES-256-GCM with derived key
 *   - Server stores only encrypted vault key
 */

function isHexLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed);
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.trim();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function normalizeBase64(input: string): string {
  let normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return normalized;
}

function decodeBytesCompat(value: string): Uint8Array {
  // Backward-compat for legacy rows that may have persisted hex instead of base64.
  if (isHexLike(value) && !/[+/=_-]/.test(value)) {
    return hexToBytes(value);
  }

  try {
    return base64ToBytes(normalizeBase64(value));
  } catch {
    if (isHexLike(value)) {
      return hexToBytes(value);
    }
    throw new Error("Unsupported encoded binary format");
  }
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

/**
 * Derive vault key from passphrase using PBKDF2
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  // Import passphrase as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  // Derive AES-256-GCM key
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000, // High iteration count for security
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true, // extractable for export
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
  );

  return key;
}

/**
 * Create a new vault with passphrase protection
 */
export async function createVaultWithPassphrase(passphrase: string): Promise<{
  vaultKeyHex: string;
  recoveryKey: string;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  // Recovery key encrypted copy
  recoveryEncryptedVaultKey: string;
  recoverySalt: string;
  recoveryIv: string;
}> {
  // Generate random vault key
  const vaultKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  // Export vault key to hex
  const vaultKeyRaw = await crypto.subtle.exportKey("raw", vaultKey);
  const vaultKeyHex = Array.from(new Uint8Array(vaultKeyRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // === PASSPHRASE ENCRYPTION ===
  // Generate salt for passphrase derivation
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive encryption key from passphrase
  const encryptionKey = await deriveKeyFromPassphrase(passphrase, salt);

  // Encrypt vault key with passphrase-derived key
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedVaultKeyBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    vaultKeyRaw
  );

  // === RECOVERY KEY ENCRYPTION ===
  // Generate recovery key
  const recoveryBytes = crypto.getRandomValues(new Uint8Array(16));
  const recoveryHex = Array.from(recoveryBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const recoveryKey = `HRK-${recoveryHex
    .slice(0, 4)
    .toUpperCase()}-${recoveryHex.slice(4, 8).toUpperCase()}-${recoveryHex
    .slice(8, 12)
    .toUpperCase()}-${recoveryHex.slice(12, 16).toUpperCase()}`;

  // Generate salt and IV for recovery encryption
  const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
  const recoveryIv = crypto.getRandomValues(new Uint8Array(12));

  // Derive key from recovery key
  const recoveryDerivedKey = await deriveKeyFromPassphrase(
    recoveryKey,
    recoverySalt
  );

  // Encrypt vault key with recovery-derived key
  const recoveryEncryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: recoveryIv },
    recoveryDerivedKey,
    vaultKeyRaw
  );

  return {
    vaultKeyHex,
    recoveryKey,
    // Passphrase encrypted
    encryptedVaultKey: bytesToBase64(new Uint8Array(encryptedVaultKeyBuffer)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    // Recovery encrypted
    recoveryEncryptedVaultKey: bytesToBase64(new Uint8Array(recoveryEncryptedBuffer)),
    recoverySalt: bytesToBase64(recoverySalt),
    recoveryIv: bytesToBase64(recoveryIv),
  };
}

/**
 * Unlock vault with passphrase
 */
export async function unlockVaultWithPassphrase(
  passphrase: string,
  encryptedVaultKey: string,
  salt: string,
  iv: string
): Promise<string> {
  // Decode from base64
  const saltBytes = toCryptoBytes(decodeBytesCompat(salt));
  const ivBytes = toCryptoBytes(decodeBytesCompat(iv));
  const encryptedBytes = toCryptoBytes(decodeBytesCompat(encryptedVaultKey));

  // Derive key from passphrase
  const decryptionKey = await deriveKeyFromPassphrase(passphrase, saltBytes);

  let vaultKeyRaw: ArrayBuffer;
  try {
    // Decrypt vault key
    vaultKeyRaw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      decryptionKey,
      encryptedBytes
    );
  } catch (error: unknown) {
    // Wrong passphrase/recovery key should not crash UI flows.
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "OperationError"
    ) {
      return "";
    }
    throw error;
  }

  // Export to hex
  const vaultKeyHex = Array.from(new Uint8Array(vaultKeyRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return vaultKeyHex;
}

/**
 * Unlock vault with recovery key
 */
export async function unlockVaultWithRecoveryKey(
  recoveryKey: string,
  recoveryEncryptedVaultKey: string,
  recoverySalt: string,
  recoveryIv: string
): Promise<string> {
  // Decode from base64
  const saltBytes = toCryptoBytes(decodeBytesCompat(recoverySalt));
  const ivBytes = toCryptoBytes(decodeBytesCompat(recoveryIv));
  const encryptedBytes = toCryptoBytes(decodeBytesCompat(recoveryEncryptedVaultKey));

  // Derive key from recovery key using stored salt
  const unwrapKey = await deriveKeyFromPassphrase(recoveryKey, saltBytes);

  let vaultKeyRaw: ArrayBuffer;
  try {
    // Decrypt vault key
    vaultKeyRaw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      unwrapKey,
      encryptedBytes
    );
  } catch (error: unknown) {
    // Wrong passphrase/recovery key should not crash UI flows.
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "OperationError"
    ) {
      return "";
    }
    throw error;
  }

  // Export to hex
  const vaultKeyHex = Array.from(new Uint8Array(vaultKeyRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return vaultKeyHex;
}
