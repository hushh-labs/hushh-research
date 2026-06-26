import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on dense multi-dimensional
// integer array matrices supplied under an unrecognized top-level key (e.g.
// coordinate rows or weight indices), which fall into the "Generic array
// handling" branch:
//
//   lines.push("");
//   lines.push(`--- ${label} (${value.length} items) ---`);
//   for (const item of value.slice(0, 3)) {
//     if (typeof item === "object" && item !== null) {
//       const obj = item;
//       const firstValue = Object.values(obj).find(v => v !== null && v !== undefined);
//       lines.push(`  • ${String(firstValue || "Item")}`);
//     } else {
//       lines.push(`  • ${String(item)}`);
//     }
//   }
//   if (value.length > 3) lines.push(`  ... and ${value.length - 3} more`);
//
// TRUTH-FIRST: matrices are NOT preserved. There is NO row/column rendering, NO
// value ordering, and NO index-bound retention. The branch is destructively
// lossy for a matrix:
//   - Only the FIRST THREE rows are even visited; the rest collapse to a single
//     `  ... and N more` line. Row count beyond 3 is discarded.
//   - For each visited row (an array, i.e. typeof === "object"), it does NOT
//     print the row. It takes `Object.values(row).find(...)` — the row's FIRST
//     element — and prints only that single scalar. Every other column is lost.
//   - Because the line is `String(firstValue || "Item")`, a row whose first
//     element is the falsy integer 0 renders the literal "Item", NOT 0. So even
//     the single surviving value is corrupted for zero-led rows.
// The premise that it "maps these arrays without altering numerical value
// ordering or index bounds" is FALSE. These tests pin the real lossy contract.

describe("formatCompleteJson — dense integer matrices (generic-array branch)", () => {
  it("collapses each row to its FIRST element and caps at three rows", () => {
    const out = formatCompleteJson({
      weights: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
        [10, 11, 12],
      ],
    });
    expect(out).toBe(
      "\n--- Weights (4 items) ---\n  • 1\n  • 4\n  • 7\n  ... and 1 more"
    );
  });

  it("does NOT preserve column values or row width (only first column survives)", () => {
    const out = formatCompleteJson({ matrix: [[100, 200], [300, 400]] });
    expect(out).toBe("\n--- Matrix (2 items) ---\n  • 100\n  • 300");
    // columns 200 / 400 are entirely dropped
    expect(out).not.toContain("200");
    expect(out).not.toContain("400");
  });

  it("corrupts a zero-led row to the literal 'Item' (String(0 || 'Item'))", () => {
    const out = formatCompleteJson({ coords: [[0, 9], [5, 5]] });
    expect(out).toBe("\n--- Coords (2 items) ---\n  • Item\n  • 5");
  });

  it("keeps negative first-element values (truthy) but still drops the rest", () => {
    const out = formatCompleteJson({ grid: [[-7, -8], [-9, -10]] });
    expect(out).toBe("\n--- Grid (2 items) ---\n  • -7\n  • -9");
  });

  it("renders an exactly-three-row matrix with no overflow line", () => {
    const out = formatCompleteJson({ rows: [[1], [2], [3]] });
    expect(out).toBe("\n--- Rows (3 items) ---\n  • 1\n  • 2\n  • 3");
  });

  it("collapses deeper nesting to the row's first inner array via String([...]) (comma-joined)", () => {
    const out = formatCompleteJson({ tensor: [[[1, 2]], [[3, 4]]] });
    // row[0] === [[1,2]]; its first value is the array [1,2] → String([1,2]) === "1,2"
    expect(out).toBe("\n--- Tensor (2 items) ---\n  • 1,2\n  • 3,4");
  });
});
