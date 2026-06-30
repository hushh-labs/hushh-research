import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on deeply nested numeric
// arrays (e.g. [[[[[1]]]]]) routed through the GENERIC array branch.
//
// TRUTH-FIRST: formatCompleteJson does NOT recurse into nested arrays and does
// NOT preserve brace/bracket structure at all. There is no "structural depth
// layout" or brace-separator handling. The generic array branch:
//   - emits a header line "" + "--- <Label> (<n> items) ---"
//   - iterates only the first 3 TOP-LEVEL items (slice(0, 3))
//   - for an object/array item, picks the first non-null Object.values entry and
//     String()-coerces it; for a primitive item, String()-coerces directly
//   - appends "  ... and <n-3> more" only when length > 3
// Because depth is measured by the OUTER array length (always 1 for [[[[[1]]]]]),
// nesting depth is invisible. JS String() coercion flattens single-element nested
// arrays: String([[[[1]]]]) === "1". An empty inner array has no non-null value,
// so the fallback literal "Item" is used. Brackets/commas never appear.

describe("formatCompleteJson — deep nested array layout", () => {
  it("collapses a 5-deep single-element array to one '• 1' bullet (depth invisible)", () => {
    expect(formatCompleteJson({ data: [[[[[1]]]]] })).toBe(
      "\n--- Data (1 items) ---\n  • 1"
    );
  });

  it("reports outer length as 1 regardless of nesting depth", () => {
    expect(formatCompleteJson({ data: [[[[[1]]]]] })).toContain(
      "--- Data (1 items) ---"
    );
  });

  it("String()-flattens a 3-deep wrapper the same way (no brackets emitted)", () => {
    const out = formatCompleteJson({ data: [[[[1]]]] });
    expect(out).toBe("\n--- Data (1 items) ---\n  • 1");
    expect(out).not.toContain("[");
    expect(out).not.toContain("]");
  });

  it("uses the first Object.values entry per top-level row of a matrix", () => {
    expect(
      formatCompleteJson({ matrix: [[1, 2], [3, 4], [5, 6], [7, 8]] })
    ).toBe(
      "\n--- Matrix (4 items) ---\n  • 1\n  • 3\n  • 5\n  ... and 1 more"
    );
  });

  it("caps the listing at the first 3 top-level items with an overflow line", () => {
    expect(formatCompleteJson({ matrix: [[1, 2], [3, 4], [5, 6], [7, 8]] }))
      .toContain("... and 1 more");
  });

  it("falls back to literal 'Item' for an empty inner array (no non-null value)", () => {
    expect(formatCompleteJson({ data: [[]] })).toBe(
      "\n--- Data (1 items) ---\n  • Item"
    );
  });

  it("formats a flat numeric array verbatim per element (no nesting at all)", () => {
    expect(formatCompleteJson({ nums: [1, 2, 3] })).toBe(
      "\n--- Nums (3 items) ---\n  • 1\n  • 2\n  • 3"
    );
  });

  it("never emits bracket or comma separators for deep nesting", () => {
    const out = formatCompleteJson({ data: [[[[[1]]]]] });
    expect(out).not.toMatch(/[\[\]]/);
  });
});
