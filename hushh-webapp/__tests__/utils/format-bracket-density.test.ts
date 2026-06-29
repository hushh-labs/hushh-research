import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on top-level sections whose
// value is a deeply / densely nested *structural* array — i.e. multi-dimensional
// brackets with no object keys, e.g. [[[[ ... ]]]] nested 50+ levels deep.
//
// TRUTH-FIRST (verified against the source). A top-level array value that is
// NOT one of the special keys (holdings, activity_and_transactions,
// asset_allocation, legal_and_disclosures, historical_values) hits the
// "Generic array handling" branch:
//
//   lines.push("");
//   lines.push(`--- ${label} (${value.length} items) ---`);
//   for (const item of value.slice(0, 3)) {
//     if (typeof item === "object" && item !== null) {
//       const firstValue = Object.values(item).find(v => v != null);
//       lines.push(`  • ${String(firstValue || "Item")}`);
//     } else {
//       lines.push(`  • ${String(item)}`);
//     }
//     ...
//   }
//   if (value.length > 3) lines.push(`  ... and ${value.length - 3} more`);
//
//   Key consequences this pins:
//   1. There is NO recursive descent and NO depth tracking. The utility only
//      ever looks ONE level in (the first non-null element of each of the first
//      three items) and hands it to String(). Native Array.prototype.toString
//      then flattens the remaining brackets by joining with "," — so an
//      arbitrarily deep nest is COLLAPSED to its innermost scalar payload with
//      NO bracket characters and NO stack-overflow.
//   2. Only the first 3 top-level items are rendered; the rest become a single
//      "... and N more" line. The "(N items)" header always reflects the FULL
//      top-level length.

describe("formatCompleteJson — extreme structural-array (bracket) density", () => {
  it("does not throw or overflow on a 50+ level deep nested array", () => {
    let deep: unknown = ["DEEP_MARKER"];
    for (let i = 0; i < 60; i += 1) {
      deep = [deep];
    }
    expect(() => formatCompleteJson({ matrix: deep as unknown[] })).not.toThrow();
  });

  it("collapses all nested brackets to the innermost scalar via String() (no '[' chars)", () => {
    let deep: unknown = ["DEEP_MARKER"];
    for (let i = 0; i < 60; i += 1) {
      deep = [deep];
    }
    const out = formatCompleteJson({ matrix: deep as unknown[] });
    // Native Array.toString flattening yields the bare innermost payload.
    expect(out).toContain("• DEEP_MARKER");
    // No structural bracket characters survive in the rendered bullet line.
    const bullet = out.split("\n").find((l: string) => l.includes("DEEP_MARKER"));
    expect(bullet).toBe("  • DEEP_MARKER");
    expect(bullet).not.toContain("[");
    expect(bullet).not.toContain("]");
  });

  it("emits a section header reflecting the FULL top-level item count", () => {
    const out = formatCompleteJson({ matrix: [[1], [2], [3], [4], [5]] });
    expect(out).toContain("--- Matrix (5 items) ---");
  });

  it("renders only the first 3 items, each via its first inner value", () => {
    const out = formatCompleteJson({ matrix: [[1, 9], [2, 9], [3, 9], [4, 9]] });
    expect(out).toContain("• 1");
    expect(out).toContain("• 2");
    expect(out).toContain("• 3");
    // The 4th item is summarized, not rendered as a value bullet.
    expect(out).not.toContain("• 4");
    expect(out).toContain("... and 1 more");
  });

  it("does not append a '... more' line when there are exactly 3 items", () => {
    const out = formatCompleteJson({ matrix: [[1], [2], [3]] });
    expect(out).toContain("• 1");
    expect(out).toContain("• 3");
    expect(out).not.toContain("more");
  });

  it("collapses an innermost EMPTY array to an empty bullet payload", () => {
    // [[[]]] — first inner value chain bottoms out at [], String([]) === "".
    const out = formatCompleteJson({ matrix: [[[]]] });
    const bullet = out.split("\n").find((l: string) => l.trimStart().startsWith("•"));
    expect(bullet).toBe("  • ");
  });

  it("skips a top-level array section entirely when it is empty", () => {
    const out = formatCompleteJson({ matrix: [] });
    expect(out).not.toContain("Matrix");
  });

  it("flattens a wide multi-dimensional matrix to first-cell payloads", () => {
    const out = formatCompleteJson({
      matrix: [
        [[10, 20], [30, 40]],
        [[50, 60], [70, 80]],
      ],
    });
    // First inner value of each top item is itself an array, flattened by String.
    expect(out).toContain("• 10,20");
    expect(out).toContain("• 50,60");
  });
});
