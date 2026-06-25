import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on how JavaScript
// exponential / scientific-notation number literals (e.g. 1e-5, 2.5e6) are
// rendered.
//
// Truth-first note: there is no special "exponential" code path. A literal like
// `1e-5` is just the JS number `0.00001`; formatCompleteJson routes every number
// through one of three formatters based on the field KEY:
//   - CURRENCY_FIELDS  -> formatCurrency  (Intl USD, exactly 2 fraction digits)
//   - PERCENTAGE_FIELDS-> formatPercent   (value.toFixed(2) + "%", signed)
//   - everything else  -> formatNumber    (Intl, min 0 / max 4 fraction digits)
//
// These tests pin the resulting decimal output (never E-notation) for each path.

describe("formatCompleteJson — exponential / scientific notation numbers", () => {
  it("renders generic (non-currency) exponential numbers via formatNumber (max 4 fraction digits, no E-notation)", () => {
    const out = formatCompleteJson({
      // unknown key -> generic number path (formatNumber)
      tiny_ratio: 1e-5, // 0.00001 -> rounds to "0" at 4 fraction digits
      small_ratio: 1.5e-3, // 0.0015 -> "0.0015"
      mid_value: 1.23456e2, // 123.456 -> "123.456"
      big_count: 1e6, // 1000000 -> "1,000,000"
      negative_ratio: -2.5e-1, // -0.25 -> "-0.25"
    });

    expect(out).toContain("Tiny Ratio: 0");
    expect(out).toContain("Small Ratio: 0.0015");
    expect(out).toContain("Mid Value: 123.456");
    expect(out).toContain("Big Count: 1,000,000");
    expect(out).toContain("Negative Ratio: -0.25");
    // Never emits raw scientific notation.
    expect(out).not.toMatch(/e[+-]?\d/i);
  });

  it("renders currency-keyed exponential numbers via formatCurrency (exactly 2 fraction digits)", () => {
    const out = formatCompleteJson({
      // total_value is a CURRENCY field and a top-level scalar
      total_value: 1e-5, // 0.00001 -> "$0.00"
    });
    expect(out).toContain("Total Portfolio Value: $0.00");
    expect(out).not.toMatch(/e[+-]?\d/i);
  });

  it("renders currency exponential numbers inside an object section", () => {
    const out = formatCompleteJson({
      portfolio_summary: {
        ending_value: 2.5e6, // 2500000 -> "$2,500,000.00"
        total_change: -1.5e3, // -1500 -> "-$1,500.00"
      },
    });
    expect(out).toContain("--- Portfolio Summary ---");
    expect(out).toContain("Ending Value: $2,500,000.00");
    expect(out).toContain("Total Change: -$1,500.00");
  });

  it("renders percentage-keyed exponential numbers via formatPercent (signed, 2 fraction digits)", () => {
    const out = formatCompleteJson({
      // est_yield is a PERCENTAGE field
      est_yield: 1.25e0, // 1.25 -> "+1.25%"
    });
    expect(out).toContain("Yield: +1.25%");
  });

  it("rounds high-precision exponential mantissa to 4 fraction digits on the generic path", () => {
    const out = formatCompleteJson({
      precise: 1.23456789e-1, // 0.123456789 -> rounds to "0.1235"
    });
    expect(out).toContain("Precise: 0.1235");
  });
});
