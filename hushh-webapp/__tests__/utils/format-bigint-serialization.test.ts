import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on native BigInt values in the input object.
//
// Truth-first note on the real implementation:
//
// formatCompleteJson does NOT call JSON.stringify anywhere. The premise that
// BigInt "natively triggers structural failures" only applies to raw
// JSON.stringify (which throws "TypeError: Do not know how to serialize a
// BigInt"). This helper builds a human-readable string by branching on runtime
// type, so BigInt is handled by type-dispatch, not by JSON serialization.
//
// Two distinct, verified paths exist depending on WHERE the BigInt sits:
//
// 1) TOP-LEVEL bigint (e.g. { supply: 123n }):
//    The main section loop only handles typeof === "number" | "string",
//    Array.isArray(...), or typeof === "object". A bigint matches NONE of
//    these branches, so the entire section is SILENTLY SKIPPED — it never
//    reaches formatValue(). No throw, no output line for that key.
//
// 2) NESTED bigint (inside a section OBJECT, e.g. { section: { supply: 123n } }):
//    The object branch iterates entries and calls formatValue(key, value).
//    formatValue() returns early only for null/undefined, number, string,
//    boolean; a bigint falls through to the final `return String(value)`,
//    yielding the plain decimal digit string (e.g. "123") — NO "n" suffix,
//    NO currency/percentage formatting, NO throw.
//
// IMPORTANT: this pins the ACTUAL contract — BigInt is neither smoothly
// converted at the top level (it is dropped) nor requires a custom encoder
// (there is no JSON.stringify to fail). Any future change (explicit BigInt
// support, a custom replacer, or a thrown error) becomes a visible, deliberate
// contract change rather than silent drift.

describe("formatCompleteJson — native BigInt serialization bounds", () => {
  it("does not throw on a standalone top-level BigInt value", () => {
    expect(() => formatCompleteJson({ supply: 9007199254740991n })).not.toThrow();
  });

  it("silently drops a top-level BigInt section (no line emitted)", () => {
    const output = formatCompleteJson({ supply: 9007199254740991n });
    // The bigint matches no top-level branch, so nothing is rendered for it.
    expect(output).toBe("");
    expect(output).not.toContain("9007199254740991");
    expect(output).not.toContain("Supply");
  });

  it("does not throw on a nested BigInt value inside a section object", () => {
    expect(() =>
      formatCompleteJson({ metrics: { tracker: 12345n } }),
    ).not.toThrow();
  });

  it("renders a nested BigInt as its plain decimal string via String() fallback", () => {
    const output = formatCompleteJson({ metrics: { tracker: 12345n } });
    expect(output).toContain("--- Metrics ---");
    // String(12345n) === "12345" — no "n" suffix, no currency formatting.
    expect(output).toContain("Tracker: 12345");
    expect(output).not.toContain("12345n");
  });

  it("preserves full precision for a large nested BigInt (no Number coercion loss)", () => {
    // 2^53 + 1 would lose precision as a JS number; as BigInt it is exact.
    const output = formatCompleteJson({
      metrics: { max_safe_plus_one: 9007199254740993n },
    });
    expect(output).toContain("Max Safe Plus One: 9007199254740993");
  });

  it("keeps primitive siblings intact when a section mixes BigInt and numbers", () => {
    const output = formatCompleteJson({
      metrics: { total_value: 1000, tracker: 42n },
    });
    // Currency-formatted number sibling is unaffected...
    expect(output).toContain("Total Portfolio Value: $1,000.00");
    // ...and the nested bigint still renders via the String() fallback.
    expect(output).toContain("Tracker: 42");
  });
});
