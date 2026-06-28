import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on SPARSE arrays — arrays
// that contain explicit empty indices ("holes"), e.g. `new Array(3)` or the
// elision-comma literal `[1, , 3]`.
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that the formatter applies
// "specialized indentation properties" or "falls back to standard null value
// insertion" for holes is FALSE on BOTH counts:
//
//   1. There is NO specialized indentation path. Every generic-array element is
//      emitted with the same fixed "  • " bullet prefix as any other array.
//
//   2. Holes are NOT rendered as the literal string "null". A top-level generic
//      array is walked with `.slice(0, 3)` followed by `for (const item of ...)`.
//      The array iterator visits every index 0..length-1, so a hole is read as
//      the value `undefined`, and the non-object branch runs `String(item)` —
//      `String(undefined)` === "undefined". So holes surface as the literal
//      text "undefined", never "null".
//
//   3. The "(N items)" count uses `Array.prototype.length`, which INCLUDES holes
//      (sparse length is preserved), and the overflow line uses the same length.
//
//   4. For an OBJECT element whose value is itself a sparse array, the formatter
//      uses `Object.values(obj).find(...)`. `Object.values` enumerates only the
//      existing own indices, so it SKIPS holes — the first materialized value is
//      chosen and holes never contribute a bullet at all.
describe("formatCompleteJson — sparse arrays / nested sparse matrices", () => {
  it("renders an elision-comma hole as the literal 'undefined' (not 'null'), no special indent", () => {
    const out = formatCompleteJson({ matrix: [1, , 3] });
    expect(out).toBe(
      "\n--- Matrix (3 items) ---\n  • 1\n  • undefined\n  • 3",
    );
  });

  it("counts holes in the (N items) header via Array.length", () => {
    const out = formatCompleteJson({ matrix: [1, , 3] });
    expect(out).toContain("--- Matrix (3 items) ---");
  });

  it("renders every hole of a fully-empty new Array(3) as 'undefined' bullets", () => {
    const out = formatCompleteJson({ matrix: new Array(3) });
    expect(out).toBe(
      "\n--- Matrix (3 items) ---\n  • undefined\n  • undefined\n  • undefined",
    );
  });

  it("caps a long all-hole array at three bullets and reports the remainder by length", () => {
    const out = formatCompleteJson({ matrix: new Array(5) });
    expect(out).toBe(
      "\n--- Matrix (5 items) ---\n  • undefined\n  • undefined\n  • undefined\n  ... and 2 more",
    );
  });

  it("never emits the literal string 'null' for holes", () => {
    const out = formatCompleteJson({ matrix: [, , 7] });
    expect(out).not.toContain("null");
    // Leading holes still stringify to "undefined"; trailing real value survives.
    expect(out).toBe(
      "\n--- Matrix (3 items) ---\n  • undefined\n  • undefined\n  • 7",
    );
  });

  it("skips holes inside an object-element sparse array via Object.values (first real value wins)", () => {
    // Each row is an object element -> Object.values([row]) drops holes, so the
    // first MATERIALIZED value of each row is used (1 for row0, 4 for row1).
    const out = formatCompleteJson({ matrix: [[1, , 3], [4, 5, 6]] });
    expect(out).toBe("\n--- Matrix (2 items) ---\n  • 1\n  • 4");
  });

  it("uses the first non-hole value when a row begins with leading holes", () => {
    // Object.values([, , 9]) === [9] -> find -> 9; holes contribute nothing.
    const out = formatCompleteJson({ matrix: [[, , 9]] });
    expect(out).toBe("\n--- Matrix (1 items) ---\n  • 9");
  });

  it("reports only the count (length, holes included) for a sparse array nested in an object section", () => {
    // Object section -> array-valued field collapses to "N item(s)" by length;
    // hole values are never inspected on this branch.
    const out = formatCompleteJson({ account_metadata: { grid: new Array(4) } });
    expect(out).toBe("\n--- Account Information ---\n  Grid: 4 item(s)");
  });

  it("does not throw on a sparse array and emits no specialized indentation", () => {
    expect(() => formatCompleteJson({ matrix: new Array(3) })).not.toThrow();
    const out = formatCompleteJson({ matrix: new Array(3) });
    // Only the fixed two-space "  • " bullet prefix appears — no deeper indent.
    expect(out).not.toMatch(/\n {4}•/);
  });
});
