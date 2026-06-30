import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on high-magnitude /
// BigInt-like inputs.
//
// TRUTH-FIRST notes (verified against the source):
//   - There is no special BigInt handling. formatValue branches on
//     `typeof === "number" | "string" | "boolean"`, else `String(value)`.
//   - A top-level `number` routes through the scalar branch → formatNumber
//     (Intl en-US, maximumFractionDigits: 4) → grouped digits.
//   - A real top-level `bigint` is NOT number/string, not an array, and
//     `typeof bigint !== "object"`, so it matches NO top-level branch and is
//     SILENTLY SKIPPED.
//   - A `bigint` NESTED inside an object value falls through formatValue to
//     `String(value)`, i.e. the plain decimal digits with NO grouping and NO
//     trailing "n".
//   - A BigInt-like STRING is treated as a string → markdown-cleaned, otherwise
//     verbatim (full precision retained, since it never becomes a Number).

describe("formatCompleteJson — high-magnitude / bigint inputs", () => {
  it("formats a top-level safe large integer with en-US grouping", () => {
    // Number.MAX_SAFE_INTEGER
    const out = formatCompleteJson({ widget_count: 9007199254740991 });
    expect(out).toBe("Widget Count: 9,007,199,254,740,991");
  });

  it("preserves a BigInt-like string verbatim (full precision, no grouping)", () => {
    const big = "123456789012345678901234567890";
    const out = formatCompleteJson({ ledger_id: big });
    expect(out).toBe(`Ledger Id: ${big}`);
  });

  it("renders a nested bigint via String() — plain digits, no grouping, no 'n'", () => {
    const out = formatCompleteJson({
      account_metadata: { ledger_seq: 9007199254740993n },
    });
    expect(out).toContain("  Ledger Seq: 9007199254740993");
    expect(out).not.toContain("9007199254740993n");
    expect(out).not.toContain("9,007,199,254,740,993");
  });

  it("SKIPS a top-level bigint entirely (no line emitted)", () => {
    expect(formatCompleteJson({ ledger_seq: 9007199254740993n })).toBe("");
  });

  it("rounds a top-level number beyond 4 fractional digits (formatNumber cap)", () => {
    const out = formatCompleteJson({ ratio_metric: 1234.56789 });
    // maximumFractionDigits: 4 → 1,234.5679
    expect(out).toBe("Ratio Metric: 1,234.5679");
  });

  it("formats a nested currency field large integer as USD", () => {
    const out = formatCompleteJson({
      portfolio_summary: { ending_value: 1000000000 },
    });
    expect(out).toContain("  Ending Value: $1,000,000,000.00");
  });

  it("does not throw on a mix of bigint, big string, and big number", () => {
    expect(() =>
      formatCompleteJson({
        account_metadata: {
          seq: 9999999999999999n,
          id: "999999999999999999999",
          count: 1234567,
        },
      })
    ).not.toThrow();
  });
});
