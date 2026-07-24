import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decryptData,
  encryptData,
  type EncryptedPayload,
} from "@/lib/vault/encrypt";
import { bytesToBase64 } from "@/lib/vault/base64";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function generateHexKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toUrlSafeBase64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function flipFirstByte(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytesToBase64(bytes);
}

// Silence the safeBase64Decode error log; the test asserts on the throw,
// not the console.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// encryptData — output shape and AES-GCM parameter sanity
// ---------------------------------------------------------------------------

describe("encryptData", () => {
  it("returns a payload with the documented shape", async () => {
    const result = await encryptData("hello", generateHexKey());
    expect(result.encoding).toBe("base64");
    expect(result.algorithm).toBe("aes-256-gcm");
    expect(typeof result.ciphertext).toBe("string");
    expect(typeof result.iv).toBe("string");
    expect(typeof result.tag).toBe("string");
  });

  it("uses a 12-byte (96-bit) IV per AES-GCM spec", async () => {
    const result = await encryptData("hello", generateHexKey());
    const ivBytes = Uint8Array.from(atob(result.iv), (c) => c.charCodeAt(0));
    expect(ivBytes.length).toBe(12);
  });

  it("uses a 16-byte (128-bit) auth tag per AES-GCM spec", async () => {
    const result = await encryptData("hello", generateHexKey());
    const tagBytes = Uint8Array.from(atob(result.tag), (c) => c.charCodeAt(0));
    expect(tagBytes.length).toBe(16);
  });

  it("produces a different IV on every call (non-deterministic IV)", async () => {
    const key = generateHexKey();
    const a = await encryptData("hello", key);
    const b = await encryptData("hello", key);
    expect(a.iv).not.toBe(b.iv);
  });

  it("produces different ciphertext on every call (semantic security)", async () => {
    const key = generateHexKey();
    const a = await encryptData("hello", key);
    const b = await encryptData("hello", key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("encrypts an empty string without error", async () => {
    const result = await encryptData("", generateHexKey());
    expect(result.ciphertext).toBe("");
    expect(result.tag.length).toBeGreaterThan(0);
    expect(result.iv.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// decryptData — round-trip across realistic payload shapes
// ---------------------------------------------------------------------------

describe("decryptData (round-trip)", () => {
  it("round-trips ASCII text", async () => {
    const key = generateHexKey();
    const plaintext = "hello, world!";
    const payload = await encryptData(plaintext, key);
    expect(await decryptData(payload, key)).toBe(plaintext);
  });

  it("round-trips an empty string", async () => {
    const key = generateHexKey();
    const payload = await encryptData("", key);
    expect(await decryptData(payload, key)).toBe("");
  });

  it("round-trips Unicode (emoji + multilingual scripts)", async () => {
    const key = generateHexKey();
    const plaintext = "🔐 Hush — пароль — パスワード — 密码";
    const payload = await encryptData(plaintext, key);
    expect(await decryptData(payload, key)).toBe(plaintext);
  });

  it("round-trips JSON-shaped data without corrupting structure", async () => {
    const key = generateHexKey();
    const plaintext = JSON.stringify({
      user: "u_123",
      scopes: ["read.profile", "read.email"],
      n: 42,
      t: true,
      nested: { a: [1, 2, 3], b: null },
    });
    const payload = await encryptData(plaintext, key);
    expect(await decryptData(payload, key)).toBe(plaintext);
  });

  it("round-trips a 100 KB payload", async () => {
    const key = generateHexKey();
    const plaintext = "x".repeat(100_000);
    const payload = await encryptData(plaintext, key);
    expect(await decryptData(payload, key)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// decryptData — security guarantees (AEAD authentication)
// ---------------------------------------------------------------------------

describe("decryptData (tampering detection)", () => {
  it("rejects decryption with a different key", async () => {
    const correctKey = generateHexKey();
    const wrongKey = generateHexKey();
    const payload = await encryptData("secret", correctKey);
    await expect(decryptData(payload, wrongKey)).rejects.toBeInstanceOf(Error);
  });

  it("rejects decryption when the ciphertext is tampered with", async () => {
    const key = generateHexKey();
    const payload = await encryptData("secret", key);
    const tampered: EncryptedPayload = {
      ...payload,
      ciphertext: flipFirstByte(payload.ciphertext),
    };
    await expect(decryptData(tampered, key)).rejects.toBeInstanceOf(Error);
  });

  it("rejects decryption when the auth tag is tampered with", async () => {
    const key = generateHexKey();
    const payload = await encryptData("secret", key);
    const tampered: EncryptedPayload = {
      ...payload,
      tag: flipFirstByte(payload.tag),
    };
    await expect(decryptData(tampered, key)).rejects.toBeInstanceOf(Error);
  });

  it("rejects decryption when the IV is tampered with", async () => {
    const key = generateHexKey();
    const payload = await encryptData("secret", key);
    const tampered: EncryptedPayload = {
      ...payload,
      iv: flipFirstByte(payload.iv),
    };
    await expect(decryptData(tampered, key)).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// decryptData — Base64 input flexibility
// ---------------------------------------------------------------------------

describe("decryptData (Base64 input variants)", () => {
  it("accepts URL-safe Base64 with stripped padding", async () => {
    const key = generateHexKey();
    const plaintext = "payload across URL boundaries ?query=1&other=2";
    const payload = await encryptData(plaintext, key);

    const urlSafe: EncryptedPayload = {
      ...payload,
      ciphertext: toUrlSafeBase64(payload.ciphertext),
      iv: toUrlSafeBase64(payload.iv),
      tag: toUrlSafeBase64(payload.tag),
    };

    expect(await decryptData(urlSafe, key)).toBe(plaintext);
  });

  it("throws a clear error when ciphertext is not valid Base64", async () => {
    const key = generateHexKey();
    const broken: EncryptedPayload = {
      ciphertext: "not!@#$valid base64 ***",
      iv: "AAAAAAAAAAAAAAAA",
      tag: "AAAAAAAAAAAAAAAAAAAAAA",
      encoding: "base64",
      algorithm: "aes-256-gcm",
    };
    await expect(decryptData(broken, key)).rejects.toBeInstanceOf(Error);
  });
});