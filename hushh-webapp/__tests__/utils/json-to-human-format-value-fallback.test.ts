import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for the fallback branches of formatValue in
 * lib/utils/json-to-human.ts.
 *
 * formatValue is private; it is exercised here through formatCompleteJson
 * using object sections, which route non-null, non-object, non-array field
 * values directly to formatValue.
 *
 * The existing json-to-human-empty-and-zero.test.ts covers:
 *   - zero currency fields  (keys in CURRENCY_FIELDS)  → "$0.00"
 *   - zero percentage fields (keys in PERCENTAGE_FIELDS) → "+0.00%"
 *
 * This file pins the two FALLBACK branches that have no existing coverage:
 *
 *   1. boolean true/false   → "Yes" / "No"
 *   2. number whose key is absent from CURRENCY_FIELDS and PERCENTAGE_FIELDS
 *      → formatNumber (Intl.NumberFormat "en-US", no currency symbol,
 *        minimumFractionDigits: 0, maximumFractionDigits: 4)
 *
 * Note: the null/undefined → "N/A" branch inside formatValue is unreachable
 * through formatCompleteJson because null/undefined fields are skipped with
 * `continue` before formatValue is called.
 */

describe("formatValue — boolean fallback branch", () => {
  it("formats a boolean true field value as Yes", () => {
    // "active" is absent from FIELD_LABELS, CURRENCY_FIELDS, and PERCENTAGE_FIELDS.
    // getFieldLabel("active") → "Active" (auto-titleized).
    // formatValue("active", true) → "Yes" via the boolean branch.
    const output = formatCompleteJson({
      account_metadata: { active: true },
    });

    expect(output).toContain("Active: Yes");
  });

  it("formats a boolean false field value as No", () => {
    // false is not null/undefined, so it is not skipped by the null guard.
    // formatValue("active", false) → "No" via the boolean branch.
    const output = formatCompleteJson({
      account_metadata: { active: false },
    });

    expect(output).toContain("Active: No");
  });
});

describe("formatValue — generic number fallback branch (formatNumber)", () => {
  it("formats a non-currency non-percentage integer with en-US locale grouping", () => {
    // "quantity" is in FIELD_LABELS as "Shares" but absent from CURRENCY_FIELDS
    // and PERCENTAGE_FIELDS, so it reaches the formatNumber fallback.
    // Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    // formats 1234567 as "1,234,567".
    const output = formatCompleteJson({
      account_metadata: { quantity: 1_234_567 },
    });

    expect(output).toContain("Shares: 1,234,567");
  });

  it("formats a non-currency decimal up to four decimal places without padding", () => {
    // minimumFractionDigits: 0 — no trailing zeros.
    // maximumFractionDigits: 4 — up to four decimal places.
    const output = formatCompleteJson({
      account_metadata: { quantity: 42.5 },
    });

    expect(output).toContain("Shares: 42.5");
  });

  it("formats a non-currency whole number without a decimal point", () => {
    // minimumFractionDigits: 0 means no ".00" suffix for whole numbers.
    const output = formatCompleteJson({
      account_metadata: { quantity: 100 },
    });

    expect(output).toContain("Shares: 100");
  });
});