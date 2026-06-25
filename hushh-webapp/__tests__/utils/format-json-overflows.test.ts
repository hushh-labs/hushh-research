import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on numbers that sit on or
// outside standard safe integer bounds (Number.MAX_SAFE_INTEGER and beyond).
//
// TRUTH-FIRST: formatCompleteJson does NOT do any bigint promotion, overflow
// guarding, or "safe integer" detection. A top-level scalar number flows through
// formatValue:
//   - currency keys → Intl.NumberFormat(style:"currency", 2 frac digits)
//   - percentage keys → `${sign}${value.toFixed(2)}%`
//   - everything else → formatNumber = Intl.NumberFormat(maximumFractionDigits:4)
// Because the value is already a JS double, any precision loss happens at literal
// parse time (e.g. MAX_SAFE_INTEGER + 10 rounds to ...741000 BEFORE formatting).
// The formatter simply renders whatever double it receives, with en-US grouping.
// Non-finite values are rendered by Intl as "∞", "-∞", "NaN" (currency: "$∞").

describe("formatCompleteJson — extreme integer overflow boundaries", () => {
  it("renders MAX_SAFE_INTEGER exactly with grouping (generic key)", () => {
    expect(formatCompleteJson({ count: Number.MAX_SAFE_INTEGER })).toBe(
      "Count: 9,007,199,254,740,991"
    );
  });

  it("shows double rounding for MAX_SAFE_INTEGER + 10 (…991 + 10 → …741,000)", () => {
    expect(formatCompleteJson({ count: Number.MAX_SAFE_INTEGER + 10 })).toBe(
      "Count: 9,007,199,254,741,000"
    );
  });

  it("renders MIN_SAFE_INTEGER - 10 with the same rounding, negative", () => {
    expect(formatCompleteJson({ count: Number.MIN_SAFE_INTEGER - 10 })).toBe(
      "Count: -9,007,199,254,741,000"
    );
  });

  it("expands 1e21 to full grouped digits (no exponential in output)", () => {
    expect(formatCompleteJson({ count: 1e21 })).toBe(
      "Count: 1,000,000,000,000,000,000,000"
    );
  });

  it("renders a currency-keyed overflow with $ and 2 fraction digits", () => {
    expect(formatCompleteJson({ amount: Number.MAX_SAFE_INTEGER + 10 })).toBe(
      "Amount: $9,007,199,254,741,000.00"
    );
  });

  it("renders +Infinity as the ∞ glyph (generic key)", () => {
    expect(formatCompleteJson({ count: Number.POSITIVE_INFINITY })).toBe(
      "Count: ∞"
    );
  });

  it("renders -Infinity as -∞ (generic key)", () => {
    expect(formatCompleteJson({ count: Number.NEGATIVE_INFINITY })).toBe(
      "Count: -∞"
    );
  });

  it("renders NaN as the literal 'NaN' (generic key)", () => {
    expect(formatCompleteJson({ count: Number.NaN })).toBe("Count: NaN");
  });

  it("renders a currency-keyed +Infinity as '$∞'", () => {
    expect(formatCompleteJson({ amount: Number.POSITIVE_INFINITY })).toBe(
      "Amount: $∞"
    );
  });
});
