// lib/vault/passphrase-key.ts
import { Capacitor } from "@capacitor/core";
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

// CS-4 fix (security assessment, 2026-08-17): PBKDF2 ran at 100,000 rounds,
// well under the ~600,000 current OWASP-recommended minimum. Bumping the
// constant alone would break every existing vault: unlock re-derives the key
// with whatever iteration count is hardcoded here, so an old vault encrypted
// at 100,000 rounds would silently fail to decrypt (indistinguishable from a
// wrong passphrase) the moment this file started deriving at 600,000.
//
// The backend never interprets `salt`/`recoverySalt` — they are stored and
// returned as opaque strings (see consent-protocol's VaultKeysService) — so
// the iteration count can travel inside that same opaque string without any
// backend/schema change. New vaults are versioned and stretched at
// PBKDF2_ITERATIONS_CURRENT; existing rows have no version prefix, are
// detected as such, and keep unlocking at the original 100,000 forever.
const PBKDF2_ITERATIONS_LEGACY = 100_000;
export const PBKDF2_ITERATIONS_CURRENT = 600_000;
const KDF_SALT_VERSION_PREFIX = "hushh-kdf-v2:";

export function encodeVersionedSalt(saltBytes: Uint8Array, iterations: number): string {
  return `${KDF_SALT_VERSION_PREFIX}${iterations}:${bytesToBase64(saltBytes)}`;
}

function decodeVersionedSalt(saltField: string): {
  iterations: number;
  saltBytes: Uint8Array<ArrayBuffer>;
} {
  const trimmed = saltField.trim();
  if (trimmed.startsWith(KDF_SALT_VERSION_PREFIX)) {
    const rest = trimmed.slice(KDF_SALT_VERSION_PREFIX.length);
    const separatorIndex = rest.indexOf(":");
    if (separatorIndex > 0) {
      const iterations = Number.parseInt(rest.slice(0, separatorIndex), 10);
      const encodedSalt = rest.slice(separatorIndex + 1);
      if (Number.isFinite(iterations) && iterations > 0 && encodedSalt) {
        return {
          iterations,
          saltBytes: toCryptoBytes(decodeBytesCompat(encodedSalt)),
        };
      }
    }
  }
  // No recognized version prefix: this is a pre-existing row where the whole
  // field is just the encoded salt bytes, derived at the legacy round count.
  return {
    iterations: PBKDF2_ITERATIONS_LEGACY,
    saltBytes: toCryptoBytes(decodeBytesCompat(trimmed)),
  };
}

function updateNativeTestCryptoDiagnostics(
  values: Partial<{
    stage: string;
    errorName: string;
    subtleAvailable: boolean;
    passphraseMatchesConfig: boolean;
    passphraseUtf8Length: number;
    saltLength: number;
    ivLength: number;
    ciphertextLength: number;
  }>
): void {
  if (typeof window === "undefined") return;
  // SECURITY: this bridge is a page-writable global. Without the native
  // platform check, an injected script could set `vaultPassphrase` to a
  // guess and read `passphraseMatchesConfig` back as a passphrase oracle.
  // See isTrustedNativeTestBridge in lib/testing/native-test.ts.
  if (!Capacitor.isNativePlatform()) return;
  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (!bridge?.enabled) return;
  if (values.stage !== undefined) bridge.vaultCryptoStage = values.stage;
  if (values.errorName !== undefined) bridge.vaultCryptoErrorName = values.errorName;
  if (values.subtleAvailable !== undefined) {
    bridge.vaultCryptoSubtleAvailable = values.subtleAvailable;
  }
  if (values.passphraseMatchesConfig !== undefined) {
    bridge.vaultCryptoPassphraseMatchesConfig = values.passphraseMatchesConfig;
  }
  if (values.passphraseUtf8Length !== undefined) {
    bridge.vaultCryptoPassphraseUtf8Length = values.passphraseUtf8Length;
  }
  if (values.saltLength !== undefined) bridge.vaultCryptoSaltLength = values.saltLength;
  if (values.ivLength !== undefined) bridge.vaultCryptoIvLength = values.ivLength;
  if (values.ciphertextLength !== undefined) {
    bridge.vaultCryptoCiphertextLength = values.ciphertextLength;
  }
}

/**
 * Derive vault key from passphrase using PBKDF2
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS_CURRENT
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const encodedPassphrase = encoder.encode(passphrase);

  updateNativeTestCryptoDiagnostics({
    stage: "importKey",
    errorName: "",
    subtleAvailable: typeof crypto !== "undefined" && !!crypto.subtle,
    passphraseMatchesConfig:
      typeof window !== "undefined" &&
      window.__HUSHH_NATIVE_TEST__?.vaultPassphrase === passphrase,
    passphraseUtf8Length: encodedPassphrase.byteLength,
    saltLength: salt.byteLength,
  });

  // Import passphrase as key material
  let keyMaterial: CryptoKey;
  try {
    keyMaterial = await crypto.subtle.importKey(
      "raw",
      encodedPassphrase,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
  } catch (error: unknown) {
    updateNativeTestCryptoDiagnostics({
      stage: "importKey_error",
      errorName:
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "UnknownError",
    });
    throw error;
  }

  // Derive AES-256-GCM key
  updateNativeTestCryptoDiagnostics({ stage: "deriveKey" });
  let key: CryptoKey;
  try {
    key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt.buffer as ArrayBuffer,
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      // CS-7 fix (security assessment, 2026-08-17): this key wraps/unwraps
      // the vault master key via encrypt/decrypt below — every call site
      // (createVaultWithPassphrase, unlockVaultWithPassphrase,
      // unlockVaultWithRecoveryKey, rewrapVaultKeyWithPassphrase) only ever
      // encrypts/decrypts with it, never exports it. Non-extractable so an
      // injected script can't call exportKey() on this key even if it
      // manages to get a reference to it; encrypt/decrypt are the only
      // capabilities actually used, so wrapKey/unwrapKey are dropped too.
      false,
      ["encrypt", "decrypt"]
    );
  } catch (error: unknown) {
    updateNativeTestCryptoDiagnostics({
      stage: "deriveKey_error",
      errorName:
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "UnknownError",
    });
    throw error;
  }

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
  const encryptionKey = await deriveKeyFromPassphrase(
    passphrase,
    salt,
    PBKDF2_ITERATIONS_CURRENT
  );

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
    recoverySalt,
    PBKDF2_ITERATIONS_CURRENT
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
    salt: encodeVersionedSalt(salt, PBKDF2_ITERATIONS_CURRENT),
    iv: bytesToBase64(iv),
    // Recovery encrypted
    recoveryEncryptedVaultKey: bytesToBase64(new Uint8Array(recoveryEncryptedBuffer)),
    recoverySalt: encodeVersionedSalt(recoverySalt, PBKDF2_ITERATIONS_CURRENT),
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
  // Decode from base64. Salt may carry a version+iterations prefix (CS-4
  // fix) so a pre-existing row (no prefix) still derives at the original
  // 100,000 rounds it was actually encrypted with.
  const { iterations, saltBytes } = decodeVersionedSalt(salt);
  const ivBytes = toCryptoBytes(decodeBytesCompat(iv));
  const encryptedBytes = toCryptoBytes(decodeBytesCompat(encryptedVaultKey));

  updateNativeTestCryptoDiagnostics({
    stage: "decoded",
    errorName: "",
    saltLength: saltBytes.byteLength,
    ivLength: ivBytes.byteLength,
    ciphertextLength: encryptedBytes.byteLength,
  });

  // Derive key from passphrase
  const decryptionKey = await deriveKeyFromPassphrase(passphrase, saltBytes, iterations);

  let vaultKeyRaw: ArrayBuffer;
  try {
    // Decrypt vault key
    updateNativeTestCryptoDiagnostics({ stage: "decrypt" });
    vaultKeyRaw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      decryptionKey,
      encryptedBytes
    );
  } catch (error: unknown) {
    updateNativeTestCryptoDiagnostics({
      stage: "decrypt_error",
      errorName:
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "UnknownError",
    });
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

  updateNativeTestCryptoDiagnostics({ stage: "complete", errorName: "" });

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
  // Decode from base64 (see decodeVersionedSalt: CS-4 fix)
  const { iterations, saltBytes } = decodeVersionedSalt(recoverySalt);
  const ivBytes = toCryptoBytes(decodeBytesCompat(recoveryIv));
  const encryptedBytes = toCryptoBytes(decodeBytesCompat(recoveryEncryptedVaultKey));

  // Derive key from recovery key using stored salt
  const unwrapKey = await deriveKeyFromPassphrase(recoveryKey, saltBytes, iterations);

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
