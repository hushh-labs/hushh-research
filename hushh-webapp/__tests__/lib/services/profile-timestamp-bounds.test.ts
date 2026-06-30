/**
 * Characterization suite — @/lib/services/kai-profile-service
 *
 * Pins how the PUBLIC profile-service timestamp surface behaves when fed
 * malformed, truncated, or excessively long "ISO" date strings.
 *
 * TRUTH-FIRST NOTE (verified against source, not assumed):
 *   - The proposed premise was that the public service "gracefully normalizes
 *     or ignores malformed temporal inputs." That is only half true. The actual
 *     shipped behavior is:
 *       * `resolveHorizonAnchorAt` is the only EXPORTED function that takes
 *         timestamp-shaped params. It performs NO date parsing or validation.
 *         It is pure opaque string selection:
 *           - choice "keep_original" -> previousAnchorAt ?? now
 *           - otherwise              -> now
 *         Whatever string is passed (garbage, truncated, 10k chars) is returned
 *         verbatim. It never throws and never coerces to a Date.
 *       * The string-level sanitation that DOES exist (`normalizeOptionalIso`)
 *         is module-private and unexported. It only type-guards + trims +
 *         maps empty-string to null. It does NOT reject non-ISO content.
 *
 *   These tests therefore pin the real contract: the exported temporal surface
 *   is a total, non-validating passthrough/selector. This is the behavior any
 *   future refactor must preserve (or consciously, visibly change).
 */

import { describe, it, expect } from "vitest";

import { resolveHorizonAnchorAt } from "@/lib/services/kai-profile-service";

const MALFORMED_TIMESTAMPS = [
  "", // empty
  "not-a-date",
  "2024-13-45T99:99:99Z", // structurally ISO-ish but semantically impossible
  "2024-01-01", // truncated (date only)
  "2024-01-01T00:00", // truncated (no seconds / zone)
  "1970-01-01T00:00:00.000Z extra trailing garbage",
  "🚀-not-a-timestamp-🚀",
  `2024-01-01T00:00:00.000Z${"0".repeat(10_000)}`, // excessively long
];

describe("kai-profile-service · resolveHorizonAnchorAt timestamp boundaries (public contract)", () => {
  it("returns `now` verbatim for the from_now choice regardless of how malformed it is", () => {
    for (const now of MALFORMED_TIMESTAMPS) {
      const result = resolveHorizonAnchorAt({
        previousAnchorAt: "2020-01-01T00:00:00.000Z",
        now,
        choice: "from_now",
      });
      expect(result).toBe(now);
    }
  });

  it("returns the malformed previousAnchorAt verbatim for keep_original (no validation, no coercion)", () => {
    for (const previousAnchorAt of MALFORMED_TIMESTAMPS) {
      const result = resolveHorizonAnchorAt({
        previousAnchorAt,
        now: "2025-06-30T00:00:00.000Z",
        choice: "keep_original",
      });
      expect(result).toBe(previousAnchorAt);
    }
  });

  it("falls back to `now` when keep_original is chosen but there is no previous anchor", () => {
    const now = "2025-06-30T00:00:00.000Z";
    expect(
      resolveHorizonAnchorAt({ previousAnchorAt: null, now, choice: "keep_original" })
    ).toBe(now);
  });

  it("never throws or coerces malformed temporal strings into Date objects", () => {
    for (const value of MALFORMED_TIMESTAMPS) {
      let result: unknown;
      expect(() => {
        result = resolveHorizonAnchorAt({
          previousAnchorAt: value,
          now: value,
          choice: "keep_original",
        });
      }).not.toThrow();
      // Output is the raw string, not a Date and not normalized.
      expect(typeof result).toBe("string");
      expect(result).not.toBeInstanceOf(Date);
    }
  });

  it("preserves an excessively long timestamp byte-for-byte (no truncation in the selector)", () => {
    const huge = `2024-01-01T00:00:00.000Z${"9".repeat(50_000)}`;
    const result = resolveHorizonAnchorAt({
      previousAnchorAt: huge,
      now: "2025-06-30T00:00:00.000Z",
      choice: "keep_original",
    });
    expect(result).toBe(huge);
    expect(result.length).toBe(huge.length);
  });
});
