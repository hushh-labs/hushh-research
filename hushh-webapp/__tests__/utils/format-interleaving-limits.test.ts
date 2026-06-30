import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on a top-level array whose
// elements interleave objects, arrays, and primitive numbers
// (e.g. [{}, [], 123, [{}]]).
//
// Relevant implementation (the "generic array" branch):
//   lines.push("");
//   lines.push(`--- ${label} (${value.length} items) ---`);
//   for (const item of value.slice(0, 3)) {
//     if (typeof item === "object" && item !== null) {
//       const firstValue = Object.values(item).find(v => v != null);
//       lines.push(`  • ${String(firstValue || "Item")}`);
//     } else {
//       lines.push(`  • ${String(item)}`);
//     }
//   }
//   if (value.length > 3) lines.push(`  ... and ${value.length - 3} more`);
//
// TRUTH-FIRST: there are NO per-index "separators" and NO index numbers. Each
// of the FIRST THREE elements becomes a `  • ` bullet line; any remainder
// collapses to a single `  ... and N more` line. Type handling is lossy, not
// structural:
//   - object/array → the first non-null *value* via Object.values(...).find,
//     else the literal "Item". An empty object `{}` and empty array `[]` both
//     have no values → both render as `  • Item`.
//   - an element whose first value is itself an object/array leaks
//     `String(obj)` === "[object Object]".
//   - primitives render as `String(item)`.
// The premise of "index separators" / structural segmentation is FALSE; these
// tests pin the real bullet/cap behavior.

describe("formatCompleteJson — interleaved top-level array", () => {
  it("renders [{}, [], 123, [{}]] as 3 bullets + a single overflow line (no index separators)", () => {
    const out = formatCompleteJson({ items: [{}, [], 123, [{}]] });
    expect(out).toBe(
      "\n--- Items (4 items) ---\n  • Item\n  • Item\n  • 123\n  ... and 1 more"
    );
  });

  it("collapses empty object and empty array elements both to '• Item'", () => {
    const out = formatCompleteJson({ items: [{}, []] });
    expect(out).toBe("\n--- Items (2 items) ---\n  • Item\n  • Item");
  });

  it("uses the first non-null property value for an object element", () => {
    const out = formatCompleteJson({ items: [{ name: "Alpha" }, 7] });
    expect(out).toBe("\n--- Items (2 items) ---\n  • Alpha\n  • 7");
  });

  it("leaks '[object Object]' when an element's first value is itself an object", () => {
    const out = formatCompleteJson({ items: [[{ a: 1 }], 5] });
    expect(out).toBe("\n--- Items (2 items) ---\n  • [object Object]\n  • 5");
  });

  it("shows exactly the first three elements when length is exactly 3 (no overflow line)", () => {
    const out = formatCompleteJson({ items: [1, 2, 3] });
    expect(out).toBe("\n--- Items (3 items) ---\n  • 1\n  • 2\n  • 3");
  });

  it("pluralizes the overflow count literally (no separators) for long arrays", () => {
    const out = formatCompleteJson({ items: [1, 2, 3, 4, 5, 6] });
    expect(out).toBe(
      "\n--- Items (6 items) ---\n  • 1\n  • 2\n  • 3\n  ... and 3 more"
    );
  });
});
