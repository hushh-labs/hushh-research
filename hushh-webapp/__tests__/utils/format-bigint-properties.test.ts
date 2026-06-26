import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on how native JavaScript
// BigInt primitives behave across the distinct financial "data planes" of the
// formatter (top-level scalar, generic nested object, currency-keyed fields,
// and the specialized holdings / asset_allocation array planes).
//
// TRUTH-FIRST PREMISE CORRECTION:
//   The task framing ("documenting whether it stringifies the primitive or
//   triggers expected type boundaries") implies a single uniform contract.
//   Reading the source shows there is NO uniform BigInt handling — behavior is
//   PLANE-DEPENDENT, and a sibling suite (format-json-bigint.test.ts) already
//   pins the top-level-skip / nested-String() / big-string paths. To avoid
//   duplicating that file, THIS suite pins the still-uncharacterized ASSET /
//   currency planes:
//
//   formatValue() branches on typeof === "number" | "string" | "boolean", else
//   String(value). A bigint is none of the first three, so:
//     1. Top-level bigint        → matches no top-level branch → SILENTLY SKIPPED.
//     2. Generic nested bigint    → String(value): plain decimal digits, no "n".
//     3. Currency-KEYED nested bigint → STILL String(value), because the currency
//        gate is `typeof value === "number"`. A bigint bypasses formatCurrency
//        entirely → plain digits, NOT "$..." and NOT grouped. (Type boundary is
//        NOT triggered here.)
//     4. holdings[].market_value bigint → the holdings plane calls
//        formatCurrency(value as number) UNCONDITIONALLY (only null/undefined
//        guarded). formatCurrency runs Math.abs(value), and Math.abs throws on a
//        BigInt → the WHOLE call THROWS (TypeError). This is the real type
//        boundary, and it is unguarded.
//     5. asset_allocation[].percentage bigint → that plane calls
//        (pct as number).toFixed(1); BigInt has no toFixed → THROWS (TypeError).
//
// These assertions document the actual, asymmetric reality.
describe("formatCompleteJson — BigInt asset-property invariants (plane-dependent)", () => {
  it("renders a currency-KEYED nested bigint as plain digits — the currency gate (typeof number) bypasses formatCurrency", () => {
    const out = formatCompleteJson({
      portfolio_summary: { ending_value: 9007199254740991n },
    });
    // String(bigint) path, NOT formatCurrency.
    expect(out).toContain("  Ending Value: 9007199254740991");
    expect(out).not.toContain("$");
    expect(out).not.toContain("9,007,199,254,740,991");
    expect(out).not.toContain("9007199254740991n");
  });

  it("renders a generic nested bigint via String() — no grouping, no trailing 'n'", () => {
    const out = formatCompleteJson({
      account_metadata: { asset_units: 123456789012345678901234567890n },
    });
    expect(out).toContain(
      "  Asset Units: 123456789012345678901234567890",
    );
    expect(out).not.toContain("123456789012345678901234567890n");
  });

  it("renders a percentage-keyed nested bigint via String() (object plane uses formatValue, not toFixed)", () => {
    const out = formatCompleteJson({
      account_metadata: { est_yield: 7n },
    });
    // formatValue's percentage gate is also typeof === number; bigint → String().
    expect(out).toContain("  Yield: 7");
    expect(out).not.toContain("+7.00%");
  });

  it("THROWS on a holdings[].market_value bigint — formatCurrency runs Math.abs(bigint) unguarded", () => {
    expect(() =>
      formatCompleteJson({
        holdings: [
          { symbol_cusip: "AAPL", market_value: 9007199254740993n },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("THROWS on an asset_allocation[].percentage bigint — that plane calls bigint.toFixed", () => {
    expect(() =>
      formatCompleteJson({
        asset_allocation: [{ category: "Equity", percentage: 60n }],
      }),
    ).toThrow(TypeError);
  });

  it("does NOT throw when a bigint rides a holdings symbol field (only market_value/gain_loss reach formatCurrency)", () => {
    expect(() =>
      formatCompleteJson({
        holdings: [{ symbol_cusip: 12345678901234567890n }],
      }),
    ).not.toThrow();
    const out = formatCompleteJson({
      holdings: [{ symbol_cusip: 12345678901234567890n }],
    });
    expect(out).toContain("  • 12345678901234567890");
  });

  it("SKIPS a top-level bigint asset id entirely (no line emitted)", () => {
    expect(formatCompleteJson({ asset_id: 9007199254740993n })).toBe("");
  });

  it("preserves full precision for a generic-array bigint element via String()", () => {
    const out = formatCompleteJson({
      ledger_entries: [99999999999999999999n],
    });
    expect(out).toContain("--- Ledger Entries (1 items) ---");
    expect(out).toContain("  • 99999999999999999999");
  });
});
