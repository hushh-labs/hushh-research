import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native JavaScript Date
// objects and raw ISO timestamp strings inside payload values.
//
// TRUTH-FIRST (verified against the source):
//   - ISO timestamp STRINGS are values of typeof "string". At the top level
//     they take the scalar branch:  `${label}: ${formatValue(key, value)}`.
//     formatValue → cleanMarkdown only strips *, **, ***, ` and trims ends; an
//     ISO string contains none of those, so it is emitted VERBATIM with full
//     precision (fractional seconds and offset preserved).
//   - A native Date is typeof "object" (and not an Array). At the TOP level it
//     takes the "Handle objects" branch, which prints a `--- Label ---` header
//     and then iterates Object.entries(date). A Date has NO own enumerable
//     properties, so the loop yields nothing: the timestamp is silently DROPPED
//     (no value line) and NO exception is thrown.
//   - A Date NESTED inside an object section hits the nested-object branch,
//     which prints `  <Label>:` and then iterates the Date's (empty) entries,
//     so again only an empty label line remains — precision is dropped.
//   - A Date inside an array hits the generic array branch: Object.values(date)
//     is empty, so `String(firstValue || "Item")` collapses to the literal
//     "Item".
//   - The formatter NEVER calls .toISOString()/.toString() on a Date; it relies
//     purely on enumerable own properties, which Date does not expose.

describe("formatCompleteJson — ISO timestamp strings", () => {
  it("emits a top-level ISO string verbatim with full precision", () => {
    expect(
      formatCompleteJson({ custom_ts: "2023-12-31T23:59:59.999Z" })
    ).toBe("Custom Ts: 2023-12-31T23:59:59.999Z");
  });

  it("preserves fractional seconds and a numeric UTC offset exactly", () => {
    expect(
      formatCompleteJson({ custom_ts: "2023-06-15T08:30:00.123+05:30" })
    ).toBe("Custom Ts: 2023-06-15T08:30:00.123+05:30");
  });

  it("emits an ISO string verbatim when nested inside an object section", () => {
    expect(
      formatCompleteJson({
        portfolio_summary: { as_of: "2023-12-31T23:59:59.999Z" },
      })
    ).toBe(
      "\n--- Portfolio Summary ---\n  As Of: 2023-12-31T23:59:59.999Z"
    );
  });
});

describe("formatCompleteJson — native Date objects", () => {
  it("drops a top-level Date to a bare header (no value line, no throw)", () => {
    const d = new Date("2023-12-31T23:59:59.999Z");
    expect(formatCompleteJson({ custom_ts: d })).toBe("\n--- Custom Ts ---");
  });

  it("drops a nested Date to an empty label line (precision lost)", () => {
    const d = new Date("2023-12-31T23:59:59.999Z");
    expect(
      formatCompleteJson({ portfolio_summary: { as_of: d } })
    ).toBe("\n--- Portfolio Summary ---\n  As Of:");
  });

  it("collapses Date items in an array to the literal 'Item'", () => {
    const a = new Date("2023-01-01T00:00:00.000Z");
    const b = new Date("2024-01-01T00:00:00.000Z");
    expect(formatCompleteJson({ events: [a, b] })).toBe(
      "\n--- Events (2 items) ---\n  • Item\n  • Item"
    );
  });

  it("does not throw on an invalid Date value", () => {
    const invalid = new Date("not-a-real-date");
    expect(() => formatCompleteJson({ custom_ts: invalid })).not.toThrow();
    expect(formatCompleteJson({ custom_ts: invalid })).toBe(
      "\n--- Custom Ts ---"
    );
  });
});
