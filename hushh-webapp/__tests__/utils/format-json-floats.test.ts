import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) on dense / repeating
// floating-point values such as `0.1 + 0.2` and `1 / 3`.
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   Top-level scalar numbers render as `${Label}: ${formatValue(key, value)}`.
//   For a generic (non-currency, non-percentage) key, formatValue routes
//   numbers through formatNumber:
//
//     new Intl.NumberFormat("en-US", {
//       minimumFractionDigits: 0,
//       maximumFractionDigits: 4,
//     }).format(value)
//
// CORRECTION TO THE TASK PREMISE: there is NO raw IEEE-754 passthrough and
// no preservation of "trailing digits." The layout NEVER emits the full
// binary artifact (e.g. "0.30000000000000004"). maximumFractionDigits: 4
// rounds the fraction to at most four places and minimumFractionDigits: 0
// strips trailing zeros, so:
//   - 0.1 + 0.2  -> "0.3"
//   - 1 / 3      -> "0.3333"
//   - 2 / 3      -> "0.6667"  (rounded, not truncated)
// These tests pin that bounded, rounded layout.

describe("formatCompleteJson — floating-point fraction layout is bounded to <=4 rounded digits", () => {
  it("collapses 0.1 + 0.2 to '0.3' (no IEEE-754 trailing-digit artifact)", () => {
    const out = formatCompleteJson({ ratio: 0.1 + 0.2 });
    expect(out).toContain("Ratio: 0.3");
    expect(out).not.toContain("0.30000000000000004");
  });

  it("rounds 1/3 to exactly four fraction digits: '0.3333'", () => {
    const out = formatCompleteJson({ ratio: 1 / 3 });
    expect(out).toContain("Ratio: 0.3333");
    // Never the full repeating expansion.
    expect(out).not.toContain("0.3333333");
  });

  it("rounds (not truncates) 2/3 to '0.6667'", () => {
    const out = formatCompleteJson({ ratio: 2 / 3 });
    expect(out).toContain("Ratio: 0.6667");
    expect(out).not.toContain("0.6666");
  });

  it("strips trailing zeros because minimumFractionDigits is 0", () => {
    const out = formatCompleteJson({ ratio: 0.5 });
    expect(out).toContain("Ratio: 0.5");
    expect(out).not.toContain("0.5000");
  });

  it("rounds a 5th-place fraction up at the 4-digit boundary", () => {
    // 0.12345 -> rounds half-to-even/up at 4 places -> "0.1235" (V8/ICU: 0.1235)
    const out = formatCompleteJson({ ratio: 0.12345 });
    expect(out).toContain("Ratio: 0.1235");
  });

  it("keeps integers free of any decimal point", () => {
    const out = formatCompleteJson({ count: 42 });
    expect(out).toContain("Count: 42");
    expect(out).not.toContain("42.0");
  });
});
