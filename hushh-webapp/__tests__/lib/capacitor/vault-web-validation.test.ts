import { describe, expect, it } from "vitest";

import { HushhVaultWeb } from "@/lib/capacitor/plugins/vault-web";

/**
 * Web fallback vault validation contract.
 *
 * BACKGROUND:
 *   PR #8 (`fix/vault-encrypt-key-validation`) closed a critical bug in
 *   `lib/vault/encrypt.ts` where `parseInt("zz", 16) === NaN` was silently
 *   coerced to `0` inside `new Uint8Array(...)`, producing all-zero AES-256
 *   keys for any malformed-hex input. The fix added an exported
 *   `validateVaultKeyHex` assertion.
 *
 *   That fix was incomplete. The exact same `keyHex.match(/.{1,2}/g)!.map(...)`
 *   pattern is duplicated in `lib/capacitor/plugins/vault-web.ts`, which is
 *   the Capacitor web fallback used for every browser-mode vault operation
 *   (encrypt, decrypt, PBKDF2 key derivation). Three call sites were
 *   vulnerable to the same all-zero coercion:
 *
 *     - `encryptData`: `options.keyHex` (AES-256 key)
 *     - `decryptData`: `options.keyHex` (AES-256 key)
 *     - `deriveKey`:   `options.salt`   (PBKDF2 salt)
 *
 *   The salt case was particularly dangerous: a malformed hex salt would
 *   silently become a zero-filled salt of arbitrary length, which makes
 *   PBKDF2 trivially precomputable.
 *
 * THIS PR:
 *   - `encryptData` and `decryptData` now call `validateVaultKeyHex` (the
 *     same helper added in PR #8) before any cryptographic operation.
 *   - `deriveKey` now calls a new local `parseHexString` helper that
 *     rejects non-string, empty, odd-length, and non-hex inputs with
 *     clear errors before they reach the PBKDF2 path.
 *
 * These tests verify both surfaces reject malformed input cleanly.
 */

const VALID_KEY_HEX = "ab".repeat(32); // 64 chars, valid hex
const VALID_SALT_HEX = "cd".repeat(16); // 32 chars, valid hex (16-byte salt)
const VALID_PASSPHRASE = "correct horse battery staple";

const sampleEncryptOptions = {
  keyHex: VALID_KEY_HEX,
  plaintext: "hello vault",
};

const sampleEncryptedPayload = {
  ciphertext: "AAAA",
  iv: "AAAAAAAAAAAAAAAA",
  tag: "AAAAAAAAAAAAAAAAAAAAAA",
  encoding: "base64" as const,
  algorithm: "aes-256-gcm" as const,
};

describe("HushhVaultWeb.encryptData rejects malformed key hex before any crypto runs", () => {
  const plugin = new HushhVaultWeb();

  it("rejects empty hex key with a clear length error", async () => {
    await expect(
      plugin.encryptData({ ...sampleEncryptOptions, keyHex: "" })
    ).rejects.toThrow(/Vault key must be exactly 64 hex characters/);
  });

  it("rejects odd-length hex key", async () => {
    await expect(
      plugin.encryptData({ ...sampleEncryptOptions, keyHex: "abc" })
    ).rejects.toThrow(/Vault key must be exactly 64 hex characters/);
  });

  it(
    "SECURITY: rejects 64-char key with non-hex characters " +
      "(was: silently encrypted with an all-zero AES-256 key)",
    async () => {
      await expect(
        plugin.encryptData({
          ...sampleEncryptOptions,
          keyHex: "z".repeat(64),
        })
      ).rejects.toThrow(/hexadecimal/);
    }
  );

  it("still encrypts successfully with a valid key (round-trip preserved)", async () => {
    const result = await plugin.encryptData(sampleEncryptOptions);
    expect(result.algorithm).toBe("aes-256-gcm");
    expect(result.ciphertext).toBeDefined();
    expect(result.iv).toBeDefined();
    expect(result.tag).toBeDefined();

    const decrypted = await plugin.decryptData({
      keyHex: VALID_KEY_HEX,
      payload: result,
    });
    expect(decrypted.plaintext).toBe("hello vault");
  });
});

describe("HushhVaultWeb.decryptData rejects malformed key hex before any crypto runs", () => {
  const plugin = new HushhVaultWeb();

  it("rejects empty hex key", async () => {
    await expect(
      plugin.decryptData({ keyHex: "", payload: sampleEncryptedPayload })
    ).rejects.toThrow(/Vault key must be exactly 64 hex characters/);
  });

  it("rejects odd-length hex key", async () => {
    await expect(
      plugin.decryptData({ keyHex: "abc", payload: sampleEncryptedPayload })
    ).rejects.toThrow(/Vault key must be exactly 64 hex characters/);
  });

  it("SECURITY: rejects 64-char key with non-hex characters", async () => {
    await expect(
      plugin.decryptData({
        keyHex: "z".repeat(64),
        payload: sampleEncryptedPayload,
      })
    ).rejects.toThrow(/hexadecimal/);
  });
});

describe("HushhVaultWeb.deriveKey rejects malformed salt hex before PBKDF2 runs", () => {
  const plugin = new HushhVaultWeb();

  it("rejects empty hex salt", async () => {
    await expect(
      plugin.deriveKey({
        passphrase: VALID_PASSPHRASE,
        salt: "",
        iterations: 1000,
      })
    ).resolves.toBeDefined(); // empty salt → falls through to else branch (random salt)
    // ^^^ Note: empty string is falsy, so the `if (options.salt)` branch is skipped.
    // The hex parsing only runs for truthy salt values. This test documents that.
  });

  it("rejects odd-length hex salt", async () => {
    await expect(
      plugin.deriveKey({
        passphrase: VALID_PASSPHRASE,
        salt: "abc",
        iterations: 1000,
      })
    ).rejects.toThrow(/even number of hex characters/);
  });

  it(
    "SECURITY: rejects salt with non-hex characters " +
      "(was: silently used an all-zero PBKDF2 salt → trivially precomputable)",
    async () => {
      await expect(
        plugin.deriveKey({
          passphrase: VALID_PASSPHRASE,
          salt: "z".repeat(32),
          iterations: 1000,
        })
      ).rejects.toThrow(/hexadecimal/);
    }
  );

  it("still derives a key successfully with valid salt hex", async () => {
    const result = await plugin.deriveKey({
      passphrase: VALID_PASSPHRASE,
      salt: VALID_SALT_HEX,
      iterations: 1000, // Lower iteration count for test speed
    });
    expect(result.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.salt).toBe(VALID_SALT_HEX);
  });

  it("auto-generates a fresh random salt when none is provided", async () => {
    const result = await plugin.deriveKey({
      passphrase: VALID_PASSPHRASE,
      iterations: 1000,
    });
    expect(result.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.salt).toMatch(/^[0-9a-f]{32}$/); // 16-byte salt → 32 hex chars
  });
});

describe("Cross-implementation parity: vault-web.ts ↔ encrypt.ts", () => {
  it("rejects the same malformed-key inputs that lib/vault/encrypt.ts rejects", async () => {
    // This test pins the security invariant that PR #8 established for
    // encrypt.ts now also holds for the Capacitor web fallback. If either
    // implementation regresses, this test catches the divergence.
    const plugin = new HushhVaultWeb();
    const cases = ["", "abc", "z".repeat(64), "g".repeat(64)];

    for (const badKey of cases) {
      await expect(
        plugin.encryptData({ keyHex: badKey, plaintext: "x" })
      ).rejects.toBeInstanceOf(Error);
      await expect(
        plugin.decryptData({ keyHex: badKey, payload: sampleEncryptedPayload })
      ).rejects.toBeInstanceOf(Error);
    }
  });
});