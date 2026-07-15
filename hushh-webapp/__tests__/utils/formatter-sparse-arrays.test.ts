import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for `formatCompleteJson`
// (hushh-webapp/lib/utils/json-to-human.ts) focused on SPARSE JavaScript arrays
// carrying explicit index holes, e.g. `[1, , 3]`.
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE
// ------------------------------------------
// The task asked to document how the loop handles missing array slots "during
// `Object.entries` sequence evaluation." That framing is FALSE for arrays.
// Verified in json-to-human.ts:
//
//   • `Object.entries(json)` is used ONLY for the TOP-LEVEL record and for plain
//     OBJECT sections/nested objects. Arrays never reach `Object.entries`.
//   • Array section values are detected by `Array.isArray(...)` FIRST and are
//     iterated with `sectionValue.slice(0, N)` + `for (const item of ...)`.
//
// This distinction matters for holes:
//   • `Object.entries` / `Array.prototype.forEach` SKIP holes.
//   • `for...of` (used here) does NOT skip holes — it MATERIALIZES each hole as
//     `undefined` and visits it like any other element.
//
// Consequence (the actual contract): a hole is NOT skipped. In the GENERIC array
// branch each hole is stringified via `String(item)` → produces a literal
// "  • undefined" PLACEHOLDER line. Holes are also counted in the `(${length}
// items)` header and in the "... and N more" arithmetic, because `.length`
// includes holes.
//
// One more honest boundary: JSON has no concept of holes, so `JSON.parse` (and
// therefore `tryFormatComplete`) can never PRODUCE a sparse array. Sparse arrays
// only reach `formatCompleteJson` when it is called directly on an in-memory JS
// object — which is exactly the surface these tests pin.

describe("formatCompleteJson — sparse array inputs", () => {
  it("materializes a hole as a literal 'undefined' placeholder line (NOT skipped)", () => {
    const out = formatCompleteJson({ misc: [1, , 3] });
    expect(out).toBe(
      ["", "--- Misc (3 items) ---", "  • 1", "  • undefined", "  • 3"].join(
        "\n",
      ),
    );
  });

  it("counts holes in the array-length header ('(N items)')", () => {
    // `[, ,]` has length 2 (two holes), so the header reports 2 items.
    const out = formatCompleteJson({ misc: [, ,] });
    expect(out).toContain("--- Misc (2 items) ---");
    // Both holes surface as placeholder bullet lines.
    expect(out).toBe(
      ["", "--- Misc (2 items) ---", "  • undefined", "  • undefined"].join(
        "\n",
      ),
    );
  });

  it("includes holes when computing the '... and N more' overflow tail", () => {
    // Length 5 (three real values + two holes); generic branch renders slice(0,3)
    // then reports the remaining 2 as overflow. Holes are part of that count.
    const out = formatCompleteJson({ misc: [1, , 3, , 5] });
    expect(out).toBe(
      [
        "",
        "--- Misc (3 items) ---",
        "  • 1",
        "  • undefined",
        "  • 3",
        "  ... and 2 more",
      ].join("\n"),
    );
  });

  it("treats a fully-holey array (length > 0) as non-empty and emits placeholders", () => {
    // `Array(3)` has length 3 with all holes. The empty-array guard only skips
    // length === 0, so this is processed and yields three 'undefined' bullets.
    const out = formatCompleteJson({ misc: Array(3) });
    expect(out).toBe(
      [
        "",
        "--- Misc (3 items) ---",
        "  • undefined",
        "  • undefined",
        "  • undefined",
      ].join("\n"),
    );
  });

  it("still skips a genuinely EMPTY array (length === 0), holes or not", () => {
    // A zero-length array (no holes possible) is skipped entirely — no header.
    expect(formatCompleteJson({ misc: [] })).toBe("");
  });

  it("THROWS on a sparse OBJECT-array section (holdings), documenting the hole is not hole-safe", () => {
    // The holdings branch coerces each item to a record and reads fields off it.
    // A hole becomes `undefined`, so `undefined.symbol_cusip` throws. This pins
    // that object-array sections are NOT resilient to holes (unlike the generic
    // primitive path, which stringifies to "undefined").
    expect(() =>
      formatCompleteJson({ holdings: [{ symbol_cusip: "AAPL" }, ,] }),
    ).toThrow();
  });
});
