import { describe, expect, it } from "vitest";

import {
  createParserContext,
  formatCompleteJson,
  tryFormatComplete,
} from "@/lib/utils/json-to-human";

/**
 * Characterization spec for the public JSON payload → human-readable
 * serialization/conversion layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRUTH-FIRST PREMISE CORRECTION
 * ─────────────────────────────────────────────────────────────────────────────
 * The requesting task named a `DataVitalTracker` "utility engine" and asked to
 * import it and exercise its "stringify or JSON payload conversion layer". A
 * repo-wide search (`DataVitalTracker`, `vital.?tracker`, `data.?vital`) returns
 * ZERO results — no such symbol, class, or module exists anywhere in the repo.
 * A prior PR body (`tmp/pr-datavitaltracker-init-body.md`) already recorded the
 * same finding.
 *
 * Rather than import a fictional symbol (which would not compile and would pin
 * nothing), this spec characterizes the closest REAL, exported, load-bearing
 * "stringify / JSON payload conversion layer" whose behavior actually matches
 * the requested premise: the JSON→human serializer in
 * `hushh-webapp/lib/utils/json-to-human.ts` — specifically the exported
 * `formatCompleteJson` and `tryFormatComplete` contracts. These are the public
 * functions that convert a parsed JSON payload of tracked/extracted states into
 * a display string, and they are the exact surface the sibling `format-json-*`
 * suite already covers.
 *
 * Verified source behavior (json-to-human.ts):
 *   - `formatNumber` = Intl.NumberFormat("en-US", { max 4 frac digits }) → grouped.
 *   - Currency fields route through `formatCurrency` (USD, 2 frac digits, sign
 *     rendered as a leading "-" for negatives).
 *   - String values pass through `cleanMarkdown`, which strips only `***`, `**`,
 *     `*`, and backticks, then trims — all other (localized) punctuation and
 *     non-ASCII characters are preserved verbatim (no truncation, no transcode).
 *   - BigInt-like STRINGS are never coerced to Number, so full precision is kept.
 *   - `tryFormatComplete` strips a leading/trailing ```json fence, `JSON.parse`s,
 *     then delegates to `formatCompleteJson`; invalid JSON yields `null`.
 *
 * These assertions pin the existing shipped contract. Test-only, zero source
 * changes.
 */

describe("JSON payload serialization contract — extreme integers", () => {
  it("keeps a top-level MAX_SAFE_INTEGER fully grouped, without truncation", () => {
    const out = formatCompleteJson({ widget_count: 9007199254740991 });
    expect(out).toBe("Widget Count: 9,007,199,254,740,991");
  });

  it("serializes a huge nested currency integer without dropping digits", () => {
    const out = formatCompleteJson({
      portfolio_summary: { ending_value: 1000000000 },
    });
    expect(out).toContain("  Ending Value: $1,000,000,000.00");
  });

  it("renders a large negative currency value with a leading minus sign", () => {
    const out = formatCompleteJson({
      portfolio_summary: { total_change: -2500.5 },
    });
    expect(out).toContain("  Total Change: -$2,500.50");
  });

  it("groups a large non-currency nested integer via formatNumber", () => {
    const out = formatCompleteJson({
      account_metadata: { quantity: 1234567 },
    });
    expect(out).toContain("  Shares: 1,234,567");
  });

  it("preserves a BigInt-like string at full precision (never coerced to Number)", () => {
    const big = "123456789012345678901234567890";
    const out = formatCompleteJson({ ledger_id: big });
    expect(out).toBe(`Ledger Id: ${big}`);
    expect(out).not.toContain("e+");
  });

  it("does not throw on a payload mixing extreme number, bigint, and big string", () => {
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

describe("JSON payload serialization contract — localized punctuation", () => {
  it("preserves accented characters and localized punctuation verbatim", () => {
    const out = formatCompleteJson({
      account_holder: "Zoë – Café ¡Ñ! 中文, 日本語",
    });
    expect(out).toBe("Account Holder: Zoë – Café ¡Ñ! 中文, 日本語");
  });

  it("strips markdown emphasis tokens but keeps surrounding punctuation", () => {
    const out = formatCompleteJson({
      institution_name: "**Crédit** Agricole `S.A.` — *Paris*",
    });
    expect(out).toBe("Institution: Crédit Agricole S.A. — Paris");
  });

  it("keeps a localized numeric-looking string as-is (no grouping applied)", () => {
    // Comma/period localized grouping inside a STRING must not be reinterpreted.
    const out = formatCompleteJson({ note: "1.234.567,89 €" });
    expect(out).toBe("Note: 1.234.567,89 €");
  });
});

describe("tryFormatComplete round-trip robustness", () => {
  it("returns null for structurally invalid JSON rather than throwing", () => {
    const ctx = createParserContext();
    ctx.accumulatedJson = '{ "portfolio_summary": { "ending_value": ';
    expect(tryFormatComplete(ctx)).toBeNull();
  });

  it("parses a fenced payload and serializes extreme integers intact", () => {
    const ctx = createParserContext();
    ctx.accumulatedJson =
      '```json\n{"portfolio_summary":{"ending_value":1000000000}}\n```';
    const out = tryFormatComplete(ctx);
    expect(out).not.toBeNull();
    expect(out).toContain("--- Portfolio Summary ---");
    expect(out).toContain("  Ending Value: $1,000,000,000.00");
  });

  it("round-trips \\u-escaped localized characters without corruption", () => {
    const ctx = createParserContext();
    ctx.accumulatedJson = '{"account_holder":"Caf\\u00e9 \\u4e2d\\u6587"}';
    const out = tryFormatComplete(ctx);
    expect(out).toBe("Account Holder: Café 中文");
  });
});
