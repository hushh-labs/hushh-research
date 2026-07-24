import { afterEach, describe, expect, it, vi } from "vitest";

import { generateRecoveryKey } from "@/lib/vault/prf-auth";

/**
 * Recovery key entropy contract.
 *
 * BEFORE THIS PR (current production code):
 *   `generateRecoveryKey` allocated 16 bytes of cryptographic randomness
 *   via `crypto.getRandomValues(new Uint8Array(16))`, but used only the
 *   first 16 of 32 hex chars in the output — the first 8 bytes / 64 bits.
 *   The remaining 8 bytes / 64 bits were silently discarded.
 *
 *   Every recovery key issued by the codebase therefore had 64 bits of
 *   entropy despite consuming 128 bits of randomness from the OS RNG.
 *
 *   This is below NIST SP 800-131A's 112-bit floor for symmetric secrets
 *   and well below the 128-bit floor industry uses for recovery keys
 *   (1Password, Bitwarden, Apple iCloud Recovery Key all 128+).
 *
 * AFTER THIS PR:
 *   The full 16 bytes (128 bits) is encoded as 32 hex chars in the
 *   output. The format expands from 23 to 43 characters:
 *     OLD: HRK-XXXX-XXXX-XXXX-XXXX                            (4 groups)
 *     NEW: HRK-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX        (8 groups)
 *
 *   `unwrapVaultKey` is unchanged — it accepts any string as PBKDF2 input,
 *   so existing recovery keys (issued before this PR) still unwrap. Only
 *   newly-generated keys benefit from the strengthened entropy.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateRecoveryKey — format", () => {
  it("starts with the canonical 'HRK-' prefix", () => {
    expect(generateRecoveryKey()).toMatch(/^HRK-/);
  });

  it("matches the new 8-group, 4-char-per-group format", () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^HRK(-[0-9A-F]{4}){8}$/);
  });

  it("is exactly 43 characters (HRK + 8 dashes + 32 hex chars)", () => {
    // 'HRK' (3) + '-' (1) + 8 groups × 4 chars (32) + 7 inter-group dashes (7) = 43
    expect(generateRecoveryKey().length).toBe(43);
  });

  it("contains only uppercase hex characters in the payload", () => {
    const key = generateRecoveryKey();
    const payload = key.replace(/^HRK-/, "").replace(/-/g, "");
    expect(payload).toBe(payload.toUpperCase());
    expect(payload).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe("generateRecoveryKey — entropy contract", () => {
  it(
    "encodes ALL 128 bits of randomness — every byte from getRandomValues " +
      "is reflected in the output (closes the 64-bit silent-truncation bug)",
    () => {
      // Inject a known 16-byte input. The first 8 bytes mirror what the
      // pre-PR code WOULD have used; the last 8 bytes are what was silently
      // discarded. After the fix, the output must include hex
      // representations of all 16 bytes.
      const knownBytes = new Uint8Array([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8,
      ]);

      vi.spyOn(crypto, "getRandomValues").mockImplementation((arr) => {
        if (arr instanceof Uint8Array && arr.length === 16) {
          arr.set(knownBytes);
          return arr;
        }
        throw new Error(
          `unexpected getRandomValues call (length=${
            arr instanceof Uint8Array ? arr.length : "n/a"
          })`
        );
      });

      const key = generateRecoveryKey();

      // First half — was already encoded pre-PR (sanity check):
      expect(key).toContain("0102");
      expect(key).toContain("0304");
      expect(key).toContain("0506");
      expect(key).toContain("0708");

      // Second half — the previously-WASTED 64 bits. These hex pairs
      // would be ABSENT from the output before this PR. Their presence
      // here is the proof that the fix lands.
      expect(key).toContain("FFFE");
      expect(key).toContain("FDFC");
      expect(key).toContain("FBFA");
      expect(key).toContain("F9F8");
    }
  );

  it("requests exactly 16 bytes from crypto.getRandomValues (no waste, no over-request)", () => {
    let observedLength = -1;
    vi.spyOn(crypto, "getRandomValues").mockImplementation((arr) => {
      if (arr instanceof Uint8Array) {
        observedLength = arr.length;
        // Fill with a fixed pattern so the rest of the function still works.
        arr.set(new Uint8Array(arr.length).fill(0xab));
        return arr;
      }
      throw new Error("unexpected getRandomValues call");
    });

    generateRecoveryKey();
    expect(observedLength).toBe(16);
  });

  it("yields 50 distinct keys across 50 calls (basic uniqueness sanity)", () => {
    // 128 bits of entropy means collisions are astronomically unlikely.
    // 64 bits would also pass this test trivially, so this is a sanity
    // check on randomness, not on entropy strength.
    const samples = new Set<string>();
    for (let i = 0; i < 50; i++) {
      samples.add(generateRecoveryKey());
    }
    expect(samples.size).toBe(50);
  });
});

describe("generateRecoveryKey — backward compatibility for unwrap", () => {
  it("does NOT change the unwrap contract; existing 23-char recovery keys still work", () => {
    // The fix only changes the OUTPUT of generateRecoveryKey (longer
    // string, more entropy). `unwrapVaultKey` accepts any string as a
    // PBKDF2 password input, so users holding the old 23-char format
    // continue to unwrap successfully — the recovery key string is the
    // user's password, not a server-side artifact.
    //
    // This test exists to document that backward compatibility, not to
    // exercise unwrap (which is covered by prf-auth.test.ts in PR #2).
    const newKey = generateRecoveryKey();
    expect(newKey.length).toBe(43);
    expect(typeof newKey).toBe("string");
    // Asserting the simple invariant: the function returns a non-empty
    // string. The unwrap path never inspected the format, so any length
    // remains acceptable upstream.
  });
});