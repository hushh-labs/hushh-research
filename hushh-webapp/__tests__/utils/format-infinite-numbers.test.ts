import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on NON-FINITE numeric
// values: Number.POSITIVE_INFINITY and Number.NEGATIVE_INFINITY.
//
// TRUTH-FIRST (verified against the source AND the live Intl runtime):
//   - formatCompleteJson treats Infinity as a normal `typeof value === "number"`.
//     There is NO finite-number guard, NO NaN/Infinity sanitization, and NO
//     "N/A" fallback for non-finite numbers (the "N/A" branch only fires for
//     null/undefined).
//   - GENERIC number fields go through formatNumber → Intl.NumberFormat, which
//     renders the locale infinity glyph: Infinity → "∞", -Infinity → "-∞".
//   - CURRENCY fields go through formatCurrency, which formats Math.abs(value)
//     (Intl → "$∞") and re-applies a manual "-" sign for negatives:
//       Infinity  → "$∞"
//       -Infinity → "-$∞"
//   - PERCENTAGE fields go through formatPercent, which uses value.toFixed(2)
//     (NOT Intl), so the JS primitive string leaks through with a sign prefix:
//       Infinity  → "+Infinity%"   (sign is "+" because value >= 0)
//       -Infinity → "-Infinity%"
// These tests pin that exact, somewhat inconsistent, behavior.

describe("formatCompleteJson — non-finite numbers in GENERIC numeric fields", () => {
  it("renders POSITIVE_INFINITY as the locale infinity glyph '∞'", () => {
    expect(formatCompleteJson({ custom_metric: Number.POSITIVE_INFINITY })).toBe(
      "Custom Metric: ∞"
    );
  });

  it("renders NEGATIVE_INFINITY as '-∞'", () => {
    expect(formatCompleteJson({ custom_metric: Number.NEGATIVE_INFINITY })).toBe(
      "Custom Metric: -∞"
    );
  });

  it("does NOT substitute 'N/A' for a non-finite generic number", () => {
    const out = formatCompleteJson({ custom_metric: Number.POSITIVE_INFINITY });
    expect(out).not.toContain("N/A");
  });
});

describe("formatCompleteJson — non-finite numbers in CURRENCY fields", () => {
  it("renders POSITIVE_INFINITY currency as '$∞'", () => {
    expect(
      formatCompleteJson({ portfolio_summary: { ending_value: Number.POSITIVE_INFINITY } })
    ).toBe("\n--- Portfolio Summary ---\n  Ending Value: $∞");
  });

  it("renders NEGATIVE_INFINITY currency with a manual leading '-' as '-$∞'", () => {
    expect(
      formatCompleteJson({ portfolio_summary: { ending_value: Number.NEGATIVE_INFINITY } })
    ).toBe("\n--- Portfolio Summary ---\n  Ending Value: -$∞");
  });
});

describe("formatCompleteJson — non-finite numbers in PERCENTAGE fields", () => {
  it("leaks the JS primitive via toFixed: POSITIVE_INFINITY → '+Infinity%'", () => {
    expect(
      formatCompleteJson({ holdings_meta: { est_yield: Number.POSITIVE_INFINITY } })
    ).toBe("\n--- Holdings Meta ---\n  Yield: +Infinity%");
  });

  it("leaks the JS primitive via toFixed: NEGATIVE_INFINITY → '-Infinity%'", () => {
    expect(
      formatCompleteJson({ holdings_meta: { est_yield: Number.NEGATIVE_INFINITY } })
    ).toBe("\n--- Holdings Meta ---\n  Yield: -Infinity%");
  });
});

describe("formatCompleteJson — non-finite numbers as a top-level scalar section", () => {
  it("formats a top-level Infinity scalar inline with its derived label", () => {
    // 'total_value' is a currency field, so the top-level scalar path still
    // routes through formatCurrency → '$∞'.
    expect(formatCompleteJson({ total_value: Number.POSITIVE_INFINITY })).toBe(
      "Total Portfolio Value: $∞"
    );
  });

  it("keeps both finite and infinite siblings, in insertion order", () => {
    expect(
      formatCompleteJson({
        portfolio_summary: {
          beginning_value: 100,
          ending_value: Number.POSITIVE_INFINITY,
        },
      })
    ).toBe(
      "\n--- Portfolio Summary ---\n  Beginning Value: $100.00\n  Ending Value: $∞"
    );
  });
});
