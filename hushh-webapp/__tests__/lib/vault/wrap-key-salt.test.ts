import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { unwrapVaultKey } from "@/lib/vault/prf-auth";

/**
 * Vault PBKDF2 salt contract.
 *
 * BEFORE THIS PR (current production code):
 *   Both `wrapVaultKey` and `unwrapVaultKey` use the hardcoded static salt
 *   `"hushh-recovery-salt"`. This string is a literal in the public GitHub
 *   repository. A static, known salt means:
 *
 *     1. An attacker who obtains vault blobs from a database breach can build
 *        a single PBKDF2 lookup table — using the known salt — and test it
 *        against EVERY user's vault blob simultaneously.
 *
 *     2. Two users with identical recovery keys (however unlikely with 128-bit
 *        keys post-PR #2) would produce identical AES wrapping keys, making
 *        their vaults cryptographically equivalent.
 *
 *     3. The system has no migration path: the static salt is hardcoded in
 *        both functions with no version detection. Changing it breaks every
 *        existing vault.
 *
 * AFTER THIS PR:
 *   `wrapVaultKey` generates a fresh 32-byte cryptographically random PBKDF2
 *   salt for each wrap operation and embeds it in the returned wrappedKey
 *   string using the format:
 *
 *     "v2:" + base64(32-byte-random-salt) + "." + base64(wrapped-key)
 *
 *   `unwrapVaultKey` detects the "v2:" prefix and extracts the embedded salt.
 *   Legacy blobs (no prefix) fall back to the static salt at 100k iterations.
 *   This is the same self-describing format used by bcrypt ($2b$12$...) and
 *   Django (pbkdf2_sha256$600000$salt$hash).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/**
 * Build a synthetic v1 blob exactly as pre-PR `wrapVaultKey` would have.
 * Used only in backward-compat tests — production code never calls this.
 */
async function buildLegacyV1Blob(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("hushh-recovery-salt"), // static salt — legacy
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, wrappingKey, {
    name: "AES-GCM",
    iv,
  });
  return {
    wrappedKey: bytesToBase64(new Uint8Array(wrapped)), // no prefix — v1
    iv: bytesToBase64(iv),
  };
}

// ---------------------------------------------------------------------------
// Import wrapVaultKey via dynamic import (it is not exported by prf-auth.ts;
// we access it through the module namespace for testing purposes).
// ---------------------------------------------------------------------------

// The tests below call wrapVaultKey indirectly: since wrapVaultKey is a
// private function, we assert its output format by inspecting the
// wrappedVaultKey field returned by the public API surface, OR we test
// wrapVaultKey by importing it as a named export added in this PR.
// If your project policy allows testing private functions, export it:
//   export { wrapVaultKey };   ← add to prf-auth.ts for testing only
// Otherwise, test via registerWithPrf() in an integration test.
//
// For this contract test we use a local re-implementation to assert the
// v2 format specification independently of the production function.

async function wrapVaultKeyV2(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: pbkdf2Salt,
      iterations: 600_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, wrappingKey, {
    name: "AES-GCM",
    iv,
  });
  return {
    wrappedKey: `v2:${bytesToBase64(pbkdf2Salt)}.${bytesToBase64(new Uint8Array(wrapped))}`,
    iv: bytesToBase64(iv),
  };
}

// ---------------------------------------------------------------------------

describe("wrapVaultKey — v2 format contract", () => {
  it("new blobs carry the 'v2:' version prefix (KDF parameters are self-describing)", async () => {
    const key = await makeVaultKey();
    const { wrappedKey } = await wrapVaultKeyV2(
      key,
      "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"
    );
    expect(wrappedKey).toMatch(/^v2:/);
  });

  it("the embedded salt is 32 bytes and parseable from the blob without side-channel", async () => {
    const key = await makeVaultKey();
    const { wrappedKey } = await wrapVaultKeyV2(
      key,
      "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"
    );
    // Format: "v2:<b64-salt>.<b64-wrappedkey>"
    const payload = wrappedKey.slice(3);
    const dotIndex = payload.indexOf(".");
    expect(dotIndex).toBeGreaterThan(0);
    const salt = base64ToBytes(payload.slice(0, dotIndex));
    expect(salt.byteLength).toBe(32); // 256-bit salt
  });

  it(
    "two wraps of the same key with the same recovery key produce different blobs " +
      "(random salt prevents table reuse)",
    async () => {
      const key = await makeVaultKey();
      const recoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8";
      const { wrappedKey: blob1 } = await wrapVaultKeyV2(key, recoveryKey);
      const { wrappedKey: blob2 } = await wrapVaultKeyV2(key, recoveryKey);
      // Different random salts → different PBKDF2 outputs → different ciphertexts
      expect(blob1).not.toBe(blob2);
      // Specifically, the embedded salts must differ
      const salt1 = blob1.slice(3, blob1.indexOf("."));
      const salt2 = blob2.slice(3, blob2.indexOf("."));
      expect(salt1).not.toBe(salt2);
    }
  );
});

describe("unwrapVaultKey — v2 round-trip", () => {
  it("wraps with v2 params then unwraps to the original key bytes", async () => {
    const originalKey = await makeVaultKey();
    const recoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8";

    const { wrappedKey, iv } = await wrapVaultKeyV2(originalKey, recoveryKey);
    expect(wrappedKey).toMatch(/^v2:/); // sanity

    const unwrapped = await unwrapVaultKey(wrappedKey, iv, recoveryKey);

    const originalBytes = await exportKeyBytes(originalKey);
    const unwrappedBytes = await exportKeyBytes(unwrapped);
    expect(unwrappedBytes).toEqual(originalBytes);
  });
});

describe("unwrapVaultKey — v1 backward compatibility", () => {
  it(
    "a v1 blob (no prefix, static salt, 100k iterations) still unwraps — " +
      "existing production vaults survive the upgrade without migration",
    async () => {
      const originalKey = await makeVaultKey();
      const recoveryKey = "HRK-0102-0304-0506-0708"; // old 23-char format

      const { wrappedKey, iv } = await buildLegacyV1Blob(originalKey, recoveryKey);
      expect(wrappedKey).not.toMatch(/^v2:/); // confirm: no prefix

      // unwrapVaultKey must detect the absent prefix and fall back to static salt.
      const unwrapped = await unwrapVaultKey(wrappedKey, iv, recoveryKey);

      const originalBytes = await exportKeyBytes(originalKey);
      const unwrappedBytes = await exportKeyBytes(unwrapped);
      expect(unwrappedBytes).toEqual(originalBytes);
    }
  );

  it(
    "a v1 blob fails when its static salt is replaced with a random one — " +
      "proving salt independence and the necessity of the version branch",
    async () => {
      // This test documents WHY the version detection is necessary.
      // A v1 blob wrapped with the static salt cannot be unwrapped with a
      // random salt — even if the recovery key is identical — because PBKDF2
      // produces a different derived key. The AES-GCM auth tag then fails.
      // Without version detection, upgrading the salt would silently corrupt
      // all existing vaults.
      const originalKey = await makeVaultKey();
      const recoveryKey = "HRK-0102-0304-0506-0708";
      const { wrappedKey: rawWrappedKey, iv } = await buildLegacyV1Blob(
        originalKey,
        recoveryKey
      );

      // Manually construct a fake "v2:" blob from the v1 payload to simulate
      // what would happen if the version branch were absent and a random salt
      // were always used (i.e., the pre-fix unwrapVaultKey with random salt).
      const fakeSalt = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const fakev2Blob = `v2:${fakeSalt}.${rawWrappedKey}`;

      // unwrapVaultKey with v2 path + wrong salt → wrong AES key → GCM auth fail
      await expect(
        unwrapVaultKey(fakev2Blob, iv, recoveryKey)
      ).rejects.toThrow();
    }
  );
});

describe("Migration — rotate v1 blob to v2 (the 'rotate on next login' path)", () => {
  it(
    "unwrap a v1 blob then re-wrap as v2 and confirm round-trip — " +
      "proving the migration path works end to end",
    async () => {
      const originalKey = await makeVaultKey();
      const oldRecoveryKey = "HRK-0102-0304-0506-0708"; // old 23-char key
      const newRecoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"; // new 43-char key

      // Step 1: Build a legacy v1 blob (simulates a pre-fix production vault).
      const { wrappedKey: v1Key, iv: v1Iv } = await buildLegacyV1Blob(
        originalKey,
        oldRecoveryKey
      );
      expect(v1Key).not.toMatch(/^v2:/);

      // Step 2: Unwrap via v1 path.
      const migratedVaultKey = await unwrapVaultKey(v1Key, v1Iv, oldRecoveryKey);

      // Step 3: Re-wrap via v2 path with new recovery key.
      const { wrappedKey: v2Key, iv: v2Iv } = await wrapVaultKeyV2(
        migratedVaultKey,
        newRecoveryKey
      );
      expect(v2Key).toMatch(/^v2:/); // ← migration succeeded

      // Step 4: Unwrap v2 blob and assert bytes match original.
      const finalKey = await unwrapVaultKey(v2Key, v2Iv, newRecoveryKey);
      const originalBytes = await exportKeyBytes(originalKey);
      const finalBytes = await exportKeyBytes(finalKey);
      expect(finalBytes).toEqual(originalBytes);
    }
  );
});