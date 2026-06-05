/**
 * Ephemeral Key Exchange — Rejection Posture Tests
 *
 * Verifies that each vault crypto primitive fails closed when supplied with
 * malformed, incomplete, or unauthenticated payloads. Every test asserts a
 * rejection rather than a usable key or plaintext output — no fallback return
 * value, no silent no-op.
 *
 * Production modules under test
 *   lib/vault/export-encrypt.ts  – X25519 ECDH ephemeral wrapping + AES-256-GCM export
 *   lib/vault/encrypt.ts         – AES-256-GCM vault encrypt / decrypt
 *   lib/vault/prf-auth.ts        – PBKDF2 + AES-GCM recovery-key unwrapping
 */

import { describe, expect, it } from "vitest";
import {
  wrapExportKeyForConnector,
  encryptForExport,
  decryptExport,
  generateExportKey,
} from "@/lib/vault/export-encrypt";
import {
  encryptData,
  decryptData,
  type EncryptedPayload,
} from "@/lib/vault/encrypt";
import { unwrapVaultKey } from "@/lib/vault/prf-auth";
import { bytesToBase64 } from "@/lib/vault/base64";

// ─── local test helpers ───────────────────────────────────────────────────

/** 32-byte hex key filled with a constant octet — valid AES-256 raw key material. */
function fixedKeyHex(fill = 0xab): string {
  return Array.from({ length: 32 }, () => fill.toString(16).padStart(2, "0")).join("");
}

/** Generate a fresh X25519 public key and return it as base64. */
async function freshX25519PublicKeyBase64(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    { name: "X25519" } as unknown as AlgorithmIdentifier,
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return bytesToBase64(new Uint8Array(raw));
}

/**
 * Mirrors the unexported wrapVaultKey logic from prf-auth.ts (PBKDF2 + AES-GCM,
 * same salt / iteration count) so rejection tests can start from a legitimately
 * wrapped blob rather than random garbage.
 */
async function wrapKeyForTest(
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const enc = new TextEncoder();
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("hushh-recovery-salt"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", aesKey, wrappingKey, {
    name: "AES-GCM",
    iv,
  });
  return {
    wrappedKey: bytesToBase64(new Uint8Array(wrapped)),
    iv: bytesToBase64(iv),
  };
}

// ─── wrapExportKeyForConnector — X25519 ECDH ephemeral key exchange ────────

describe("wrapExportKeyForConnector — X25519 ephemeral key exchange", () => {
  it("rejects an empty connector public key", async () => {
    await expect(
      wrapExportKeyForConnector({
        exportKeyHex: fixedKeyHex(),
        connectorPublicKey: "",
      })
    ).rejects.toThrow();
  });

  it("rejects a connector public key that is too short (5 bytes, X25519 requires 32)", async () => {
    const shortKey = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(
      wrapExportKeyForConnector({
        exportKeyHex: fixedKeyHex(),
        connectorPublicKey: shortKey,
      })
    ).rejects.toThrow();
  });

  it("rejects a connector public key that is off by one byte (31 bytes)", async () => {
    const almostRight = bytesToBase64(new Uint8Array(31).fill(0x42));
    await expect(
      wrapExportKeyForConnector({
        exportKeyHex: fixedKeyHex(),
        connectorPublicKey: almostRight,
      })
    ).rejects.toThrow();
  });

  it("rejects an empty export key hex (null hex parse crash)", async () => {
    const validPubKey = await freshX25519PublicKeyBase64();
    await expect(
      wrapExportKeyForConnector({
        exportKeyHex: "",
        connectorPublicKey: validPubKey,
      })
    ).rejects.toThrow();
  });

  it("rejects a connector public key whose base64 encoding contains illegal characters", async () => {
    // exportKeyHex is encrypted as plaintext, so its length never causes a crypto
    // error. The connector public key is decoded first via atob — illegal base64
    // characters throw before any WebCrypto operation runs.
    await expect(
      wrapExportKeyForConnector({
        exportKeyHex: fixedKeyHex(),
        connectorPublicKey: "!!!invalid-base64-payload!!!",
      })
    ).rejects.toThrow();
  });
});

// ─── decryptData — AES-256-GCM vault decryption ───────────────────────────

describe("decryptData — AES-256-GCM authentication", () => {
  it("rejects ciphertext authenticated with a different vault key", async () => {
    const rightKey = fixedKeyHex(0x11);
    const wrongKey = fixedKeyHex(0x22);
    const payload = await encryptData("sensitive-data", rightKey);
    await expect(decryptData(payload, wrongKey)).rejects.toThrow();
  });

  it("rejects a payload with a single-bit flip in the auth tag", async () => {
    const key = fixedKeyHex();
    const payload = await encryptData("sensitive-data", key);
    const tagBytes = Uint8Array.from(atob(payload.tag), (c) => c.charCodeAt(0));
    tagBytes[0] ^= 0x01;
    const corruptedTag = btoa(String.fromCharCode(...tagBytes));
    await expect(
      decryptData({ ...payload, tag: corruptedTag }, key)
    ).rejects.toThrow();
  });

  it("rejects a payload where the IV has been swapped out (wrong nonce)", async () => {
    const key = fixedKeyHex();
    const payload = await encryptData("sensitive-data", key);
    const wrongIv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    await expect(
      decryptData({ ...payload, iv: wrongIv }, key)
    ).rejects.toThrow();
  });

  it("rejects a payload whose IV is not valid base64", async () => {
    const key = fixedKeyHex();
    const payload: EncryptedPayload = {
      ciphertext: bytesToBase64(new Uint8Array(32)),
      iv: "!!!NOT_BASE64!!!",
      tag: bytesToBase64(new Uint8Array(16)),
      encoding: "base64",
      algorithm: "aes-256-gcm",
    };
    await expect(decryptData(payload, key)).rejects.toThrow();
  });

  it("rejects a payload whose IV has been replaced with a single zero byte", async () => {
    const key = fixedKeyHex();
    const payload = await encryptData("sensitive-data", key);
    const truncatedIv = bytesToBase64(new Uint8Array([0x00]));
    await expect(
      decryptData({ ...payload, iv: truncatedIv }, key)
    ).rejects.toThrow();
  });
});

// ─── decryptExport — AES-256-GCM export decryption ───────────────────────

describe("decryptExport — AES-256-GCM export authentication", () => {
  it("rejects ciphertext encrypted with a different export key", async () => {
    const rightKey = await generateExportKey();
    const wrongKey = await generateExportKey();
    const { ciphertext, iv, tag } = await encryptForExport("export-payload", rightKey);
    await expect(decryptExport(ciphertext, iv, tag, wrongKey)).rejects.toThrow();
  });

  it("rejects a structurally invalid IV (1 byte instead of 12)", async () => {
    const key = await generateExportKey();
    const { ciphertext, tag } = await encryptForExport("export-payload", key);
    const shortIv = bytesToBase64(new Uint8Array([0x01]));
    await expect(decryptExport(ciphertext, shortIv, tag, key)).rejects.toThrow();
  });

  it("rejects a payload with a bitflipped auth tag (cryptographic authentication failure)", async () => {
    const key = await generateExportKey();
    const { ciphertext, iv, tag } = await encryptForExport("export-payload", key);
    const tagBytes = Uint8Array.from(atob(tag), (c) => c.charCodeAt(0));
    tagBytes[0] ^= 0xff;
    const corruptedTag = btoa(String.fromCharCode(...tagBytes));
    await expect(
      decryptExport(ciphertext, iv, corruptedTag, key)
    ).rejects.toThrow();
  });
});

// ─── unwrapVaultKey — PBKDF2+AES-GCM recovery-key unwrapping ─────────────

describe("unwrapVaultKey — PBKDF2+AES-GCM recovery key unwrapping", () => {
  it("rejects an arbitrary byte blob that was never a wrapped key", async () => {
    const garbled = bytesToBase64(new Uint8Array(48).fill(0xde));
    const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    await expect(
      unwrapVaultKey(garbled, iv, "HRK-0000-0000-0000-0000")
    ).rejects.toThrow();
  });

  it("rejects a legitimately wrapped key when the recovery key is wrong", async () => {
    const correctKey = "HRK-ABCD-EFGH-IJKL-MNOP";
    const wrongKey = "HRK-ZZZZ-ZZZZ-ZZZZ-ZZZZ";
    const { wrappedKey, iv } = await wrapKeyForTest(correctKey);
    await expect(unwrapVaultKey(wrappedKey, iv, wrongKey)).rejects.toThrow();
  });

  it("rejects a truncated wrapped key blob (too short to contain a 16-byte auth tag)", async () => {
    const truncated = bytesToBase64(new Uint8Array(8));
    const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    await expect(
      unwrapVaultKey(truncated, iv, "HRK-TEST-TEST-TEST-TEST")
    ).rejects.toThrow();
  });

  it("rejects a valid wrapped key paired with a swapped-out IV", async () => {
    const recoveryKey = "HRK-ABCD-EFGH-IJKL-MNOP";
    const { wrappedKey } = await wrapKeyForTest(recoveryKey);
    const wrongIv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    await expect(
      unwrapVaultKey(wrappedKey, wrongIv, recoveryKey)
    ).rejects.toThrow();
  });
});
