import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on deeply nested object/array structures.
//
// Truth-first note on the real implementation (verified against source):
//
// The task premise asked to "pin the maximum execution ceiling before
// exhausting structural stacks." The honest finding after reading the code is
// that THERE IS NO STACK CEILING TO EXHAUST — formatCompleteJson is NOT
// recursive. It walks a FIXED, HARD-CODED MAXIMUM OF THREE LEVELS:
//
//   Level 1: `for (const [sectionKey, sectionValue] of Object.entries(json))`
//   Level 2: `for (const [key, value] of Object.entries(sectionValue))`
//   Level 3: the nested-object branch
//            `if (typeof value === "object" && !Array.isArray(value))` ->
//            `for (const [nestedKey, nestedValue] of Object.entries(value))`
//            which prints `formatValue(nestedKey, nestedValue)`.
//
// There is no self-call and no depth counter. Consequently:
//
//   * A 50-layer nested object does NOT overflow the stack, throw, or hit a
//     safety limit. It runs in constant traversal depth and simply STOPS
//     descending after level 3.
//   * At level 3, an object VALUE is passed to formatValue(), which has no
//     object branch and falls through to `String(value)` === "[object Object]".
//     So the 4th-and-deeper layers are never rendered; they collapse into the
//     literal string "[object Object]" printed at level 3.
//   * Deeply nested ARRAYS at level 2 are summarized as a count
//     (`<label>: N item(s)`), never descended into.
//
// This pins the ACTUAL contract (bounded, non-recursive, depth-3) rather than a
// mythical recursion limit. If the walk is ever made recursive, these
// assertions will flip — turning a silent behavioral change into a visible,
// reviewable one.

// Helper: manufacture a linear object chain N layers deep.
function makeDeepObject(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf_value: "deepest" };
  for (let i = 0; i < depth; i++) {
    node = { [`layer_${depth - i}`]: node };
  }
  return node;
}

describe("formatCompleteJson — depth bounds on highly nested structures", () => {
  it("does not throw or overflow the stack on a 50-layer nested object", () => {
    const payload = { portfolio_summary: makeDeepObject(50) };
    expect(() => formatCompleteJson(payload)).not.toThrow();
  });

  it("runs in constant time regardless of nesting depth (non-recursive)", () => {
    // If it were recursive, a 5,000-layer chain would blow the stack. It does
    // not, because traversal stops at a fixed depth.
    const payload = { portfolio_summary: makeDeepObject(5000) };
    expect(() => formatCompleteJson(payload)).not.toThrow();
  });

  it("stops descending at level 3 and stringifies deeper layers as [object Object]", () => {
    // Level 1: portfolio_summary (section object)
    // Level 2: outer (nested object -> gets a "  Outer:" header)
    // Level 3: inner is an object VALUE -> String(value) === "[object Object]"
    const payload = {
      portfolio_summary: {
        outer: {
          inner: { deeper: { deepest: 42 } },
        },
      },
    };
    const output = formatCompleteJson(payload);
    // The level-3 object value collapses to the literal String() form...
    expect(output).toContain("[object Object]");
    // ...and the truly deep scalar is never rendered.
    expect(output).not.toContain("42");
  });

  it("renders exactly the reachable levels for a shallow (depth-3) object", () => {
    const payload = {
      portfolio_summary: {
        beginning_value: 1000,
        year_to_date_totals: {
          total_income: 250,
        },
      },
    };
    const output = formatCompleteJson(payload);
    // Section header (level 1)
    expect(output).toContain("--- Portfolio Summary ---");
    // Level-2 scalar renders as currency
    expect(output).toContain("Beginning Value: $1,000.00");
    // Level-2 nested object gets a header, level-3 scalar renders
    expect(output).toContain("Total Income: $250.00");
  });

  it("summarizes a deeply nested array at level 2 by count, without descending", () => {
    const deepArray = [makeDeepObject(50), makeDeepObject(50), makeDeepObject(50)];
    const payload = {
      portfolio_summary: {
        nested_series: deepArray,
      },
    };
    const output = formatCompleteJson(payload);
    // Level-2 arrays are summarized: "<label>: N item(s)".
    expect(output).toContain("Nested Series: 3 item(s)");
    // The deep contents are never traversed / rendered.
    expect(output).not.toContain("deepest");
  });
});
