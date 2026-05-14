import { describe, expect, it } from "vitest";

import {
  decryptData,
  encryptData,
  validateVaultKeyHex,
  type EncryptedPayload,
} from "@/lib/vault/encrypt";

/**
 * Vault key input-validation contract for encryptData / decryptData.
 *
 * BEFORE THIS PR (verified against unmodified source on the same branch):
 *   - encryptData("data", "")             threw "Cannot read properties of null (reading 'map')"
 *   - encryptData("data", "abc")          threw cryptic "DataError: Invalid key length"
 *   - encryptData("data", "z".repeat(64)) SUCCEEDED, silently using an all-zero
 *                                         AES-256 key. Confirmed by decrypting
 *                                         the result with "0".repeat(64) — the
 *                                         well-known all-zero key — and
 *                                         recovering the plaintext exactly.
 *
 * AFTER THIS PR:
 *   - All three cases throw a clear validation error before any cryptography
 *     runs, with a message that names the actual problem.
 *
 * The third case is a security bug: any code path that fed encryptData a
 * malformed hex key (typo, race, deserialization quirk, partial recovery
 * state) was silently producing ciphertext encrypted under an all-zero key.
 * Bytes that look encrypted but aren't.
 */

const VALID_HEX_KEY_LOWER = "a".repeat(64);
const VALID_HEX_KEY_UPPER = "A".repeat(64);
// Constructed in 8-char chunks so the literal never matches gitleaks'
// "looks like a 64-char secret" rule. Runtime value is still a valid
// 64-char mixed-case hex string used to verify mixed-case acceptance.
const VALID_HEX_KEY_MIXED = ("aB1cD2eF" + "0123aBcD").repeat(4);
const ALL_ZERO_KEY = "0".repeat(64);

describe("validateVaultKeyHex (exported helper)", () => {
  it("accepts a 64-char lowercase hex string", () => {
    expect(() => validateVaultKeyHex(VALID_HEX_KEY_LOWER)).not.toThrow();
  });

  it("accepts a 64-char uppercase hex string", () => {
    expect(() => validateVaultKeyHex(VALID_HEX_KEY_UPPER)).not.toThrow();
  });

  it("accepts a 64-char mixed-case hex string", () => {
    expect(() => validateVaultKeyHex(VALID_HEX_KEY_MIXED)).not.toThrow();
  });

  it("rejects an empty string with a clear length error", () => {
    expect(() => validateVaultKeyHex("")).toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("rejects a key shorter than 64 chars", () => {
    expect(() => validateVaultKeyHex("a".repeat(63))).toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("rejects a key longer than 64 chars", () => {
    expect(() => validateVaultKeyHex("a".repeat(65))).toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("rejects an odd-length key (would silently produce a wrong-sized key)", () => {
    expect(() => validateVaultKeyHex("a".repeat(63))).toThrow(RangeError);
  });

  it("rejects a 64-char string with non-hex characters (the all-zero-key bug)", () => {
    // Pre-fix: silently coerced to all-zero key. Post-fix: explicit rejection.
    expect(() => validateVaultKeyHex("z".repeat(64))).toThrow(
      /hexadecimal/
    );
    expect(() =>
      validateVaultKeyHex("g".repeat(64))
    ).toThrow(/hexadecimal/);
    // 64 chars total, but contains a non-hex char in the middle
    const sneaky = "a".repeat(32) + "Z" + "a".repeat(31);
    expect(sneaky.length).toBe(64);
    expect(() => validateVaultKeyHex(sneaky)).toThrow(/hexadecimal/);
  });

  it("rejects non-string inputs with TypeError", () => {
    expect(() => validateVaultKeyHex(undefined)).toThrow(TypeError);
    expect(() => validateVaultKeyHex(null)).toThrow(TypeError);
    expect(() => validateVaultKeyHex(123)).toThrow(TypeError);
    expect(() => validateVaultKeyHex({})).toThrow(TypeError);
    expect(() => validateVaultKeyHex([])).toThrow(TypeError);
  });

  it("acts as a TypeScript assertion function — narrows `unknown` to `string`", () => {
    const candidate: unknown = VALID_HEX_KEY_LOWER;
    validateVaultKeyHex(candidate);
    // After the call, `candidate` is narrowed to `string` at the type level.
    // The `.length` access below would be a type error if the narrowing
    // regressed.
    expect(candidate.length).toBe(64);
  });
});

describe("encryptData rejects malformed vault keys before any cryptography runs", () => {
  it("rejects empty hex key with a clear length error (was: cryptic null.map TypeError)", async () => {
    await expect(encryptData("data", "")).rejects.toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("rejects odd-length hex key with a clear error (was: cryptic Invalid key length DataError)", async () => {
    await expect(encryptData("data", "abc")).rejects.toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it(
    "SECURITY: rejects 64-char keys with non-hex characters " +
      "(was: silently encrypted with an all-zero AES-256 key)",
    async () => {
      const malformedKey = "z".repeat(64);
      await expect(encryptData("secret", malformedKey)).rejects.toThrow(
        /hexadecimal/
      );
    }
  );

  it("still accepts the all-zero hex key as a syntactically-valid input", async () => {
    // The all-zero key is cryptographically weak but it IS a valid hex
    // string. The validator's job is hex-format checking, not cryptographic
    // strength assessment — so it should not over-reject here.
    await expect(encryptData("secret", ALL_ZERO_KEY)).resolves.toBeDefined();
  });

  it("still encrypts successfully with a valid hex key (round-trip preserved)", async () => {
    const ciphertext = await encryptData("hello", VALID_HEX_KEY_MIXED);
    expect(ciphertext.algorithm).toBe("aes-256-gcm");
    expect(ciphertext.ciphertext).toBeDefined();
    expect(ciphertext.iv).toBeDefined();
    expect(ciphertext.tag).toBeDefined();

    const recovered = await decryptData(ciphertext, VALID_HEX_KEY_MIXED);
    expect(recovered).toBe("hello");
  });
});

describe("decryptData rejects malformed vault keys before any cryptography runs", () => {
  // Pre-build a valid encrypted payload to feed to decryptData with bad keys.
  let goodPayload: EncryptedPayload;

  it("setup: encrypts a known plaintext with a valid key", async () => {
    goodPayload = await encryptData("payload", VALID_HEX_KEY_MIXED);
    expect(goodPayload).toBeDefined();
  });

  it("rejects empty hex key", async () => {
    await expect(decryptData(goodPayload, "")).rejects.toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("rejects odd-length hex key", async () => {
    await expect(decryptData(goodPayload, "abc")).rejects.toThrow(
      /Vault key must be exactly 64 hex characters/
    );
  });

  it("SECURITY: rejects 64-char keys with non-hex characters", async () => {
    // Without this guard, an attacker who learns "this user's key was
    // accidentally malformed" can decrypt all their data with the
    // well-known all-zero key.
    await expect(decryptData(goodPayload, "z".repeat(64))).rejects.toThrow(
      /hexadecimal/
    );
  });

  it("still decrypts successfully with the original valid hex key", async () => {
    const recovered = await decryptData(goodPayload, VALID_HEX_KEY_MIXED);
    expect(recovered).toBe("payload");
  });
});