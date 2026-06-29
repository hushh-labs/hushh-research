import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on objects/arrays that are
// filled ENTIRELY with recurring `null` data values, e.g. { a: null, b: null }.
//
// TRUTH-FIRST (verified against the source): there is NO special "null
// compression", no whitespace/indentation variation, and no placeholder for
// dense-null structures. The formatter simply SKIPS null/undefined values:
//   - Top-level null section values hit `if (sectionValue == null) continue;`
//     and emit NOTHING.
//   - Inside an object section, each null entry hits `if (value == null)
//     continue;`, so an all-null object collapses to just its
//     `--- Label ---` header (no value lines).
//   - A nested all-null object still prints its `  <Label>:` line (the null
//     SKIP happens on the leaf entries, after the label is pushed).
//   - In arrays, null ITEMS are NOT skipped: the generic array branch stringifies
//     them as the literal "null" via `String(item)`. All-null OBJECT items in an
//     array collapse to the literal "Item" (no non-null first value found).
// Output uses "\n".join(lines), so a single leading section produces a leading
// newline.

describe("formatCompleteJson — all-null objects are omitted, not compressed", () => {
  it("a fully-null top-level object yields an empty string (every entry skipped)", () => {
    expect(formatCompleteJson({ a: null, b: null, c: null })).toBe("");
  });

  it("a fully-null object SECTION collapses to a bare header (no value lines)", () => {
    expect(
      formatCompleteJson({ portfolio_summary: { a: null, b: null, c: null } })
    ).toBe("\n--- Portfolio Summary ---");
  });

  it("does not add indentation, padding, or a placeholder for the null leaves", () => {
    const out = formatCompleteJson({
      portfolio_summary: { a: null, b: null, c: null },
    });
    // No bullet lines, no "N/A", no trailing whitespace lines.
    expect(out).not.toContain("•");
    expect(out).not.toContain("N/A");
    expect(out.split("\n")).toEqual(["", "--- Portfolio Summary ---"]);
  });

  it("a nested all-null object keeps its label line but drops every leaf", () => {
    expect(
      formatCompleteJson({
        portfolio_summary: { year_to_date_totals: { a: null, b: null } },
      })
    ).toBe("\n--- Portfolio Summary ---\n  Year To Date Totals:");
  });

  it("mixes: only non-null leaves survive inside an otherwise all-null section", () => {
    expect(
      formatCompleteJson({
        portfolio_summary: { a: null, ending_value: 100, c: null },
      })
    ).toBe("\n--- Portfolio Summary ---\n  Ending Value: $100.00");
  });
});

describe("formatCompleteJson — null inside arrays (items are NOT skipped)", () => {
  it("renders each null array item as the literal 'null'", () => {
    expect(formatCompleteJson({ misc_items: [null, null, null] })).toBe(
      "\n--- Misc Items (3 items) ---\n  • null\n  • null\n  • null"
    );
  });

  it("collapses all-null OBJECT items in an array to the literal 'Item'", () => {
    expect(
      formatCompleteJson({ misc_items: [{ a: null, b: null }, { c: null }] })
    ).toBe("\n--- Misc Items (2 items) ---\n  • Item\n  • Item");
  });

  it("an empty array is skipped entirely (no header)", () => {
    expect(formatCompleteJson({ misc_items: [] })).toBe("");
  });
});

describe("formatCompleteJson — combined all-null sections", () => {
  it("emits one bare header per all-null section, in insertion order", () => {
    expect(
      formatCompleteJson({
        account_metadata: { a: null },
        portfolio_summary: { b: null, c: null },
      })
    ).toBe(
      "\n--- Account Information ---\n\n--- Portfolio Summary ---"
    );
  });

  it("a top-level null value between sections contributes nothing", () => {
    expect(
      formatCompleteJson({
        skipped: null,
        portfolio_summary: { a: null },
      })
    ).toBe("\n--- Portfolio Summary ---");
  });
});
