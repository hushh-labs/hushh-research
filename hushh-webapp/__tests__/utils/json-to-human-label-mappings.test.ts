import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for the SECTION_LABELS and FIELD_LABELS lookup
 * tables in lib/utils/json-to-human.ts.
 *
 * Both tables are module-private constants (non-exported). Their values are
 * observable only through the output of formatCompleteJson. All assertions
 * use .toContain() to pin the specific label string without over-specifying
 * surrounding whitespace or co-occurring fields.
 *
 * DUPLICATE COVERAGE CHECK — existing files already pin:
 *   json-to-human-section-label-fallback.test.ts:
 *     account_metadata → "Account Information"  (SECTION_LABELS entry)
 *     institution_name → "Institution"           (FIELD_LABELS entry)
 *   format-complete-json-bounds.test.ts:
 *     holdings          → "Holdings"             (via "--- Holdings (2 items) ---")
 *     legal_and_disclosures → "Legal Disclosures"
 *
 * Every label tested below is absent from all known existing test files.
 *
 * Why deterministic:
 *   SECTION_LABELS and FIELD_LABELS are frozen Record<string, string> literals.
 *   formatCompleteJson is a pure synchronous function with no I/O or mutable
 *   state. The same input always produces the same output string.
 */

// =============================================================================
// SECTION_LABELS
// =============================================================================

describe("formatCompleteJson — SECTION_LABELS contract", () => {
  it("maps 'portfolio_summary' to 'Portfolio Summary' as the object section header", () => {
    const out = formatCompleteJson({ portfolio_summary: { ending_value: 1 } });
    expect(out).toContain("--- Portfolio Summary ---");
  });

  it("maps 'income_summary' to 'Income Summary'", () => {
    const out = formatCompleteJson({ income_summary: { total_income: 1 } });
    expect(out).toContain("--- Income Summary ---");
  });

  it("maps 'cash_management' to 'Cash Management'", () => {
    const out = formatCompleteJson({ cash_management: { cash_balance: 1 } });
    expect(out).toContain("--- Cash Management ---");
  });

  it("maps 'ytd_metrics' to 'Year-to-Date Metrics' (hyphen is part of the label)", () => {
    const out = formatCompleteJson({ ytd_metrics: { total_income: 1 } });
    expect(out).toContain("--- Year-to-Date Metrics ---");
  });

  it("maps 'realized_gain_loss' to 'Realized Gains/Losses' (slash in label)", () => {
    const out = formatCompleteJson({ realized_gain_loss: { net_realized: 1 } });
    expect(out).toContain("--- Realized Gains/Losses ---");
  });

  it("maps 'cash_flow' to 'Cash Flow'", () => {
    const out = formatCompleteJson({ cash_flow: { deposits: 1 } });
    expect(out).toContain("--- Cash Flow ---");
  });

  it("maps 'activity_and_transactions' to 'Transactions' for an array section header", () => {
    // Array branch emits: `--- ${sectionLabel} (${n} items) ---`
    const out = formatCompleteJson({
      activity_and_transactions: [
        { date: "2024-01-01", transaction_type: "Buy" },
      ],
    });
    expect(out).toContain("--- Transactions (1 items) ---");
  });

  it("maps 'asset_allocation' to 'Asset Allocation' for an array section header", () => {
    // Provide a valid non-null element to avoid the specialized-branch TypeError
    const out = formatCompleteJson({
      asset_allocation: [{ category: "Equities", percentage: 60 }],
    });
    expect(out).toContain("--- Asset Allocation (1 items) ---");
  });

  it("maps 'historical_values' to 'Historical Values' for an array section header", () => {
    const out = formatCompleteJson({
      historical_values: [{ date: "2024-01-01", value: 10000 }],
    });
    expect(out).toContain("--- Historical Values (1 items) ---");
  });
});

// =============================================================================
// FIELD_LABELS
// =============================================================================

describe("formatCompleteJson — FIELD_LABELS contract", () => {
  it("maps 'account_holder' to 'Account Holder'", () => {
    // String value passes through cleanMarkdown unchanged
    const out = formatCompleteJson({
      account_metadata: { account_holder: "Jane Smith" },
    });
    expect(out).toContain("Account Holder: Jane Smith");
  });

  it("maps 'account_number' to 'Account Number'", () => {
    const out = formatCompleteJson({
      account_metadata: { account_number: "XX-1234" },
    });
    expect(out).toContain("Account Number: XX-1234");
  });

  it("maps 'statement_period_start' to 'Period Start'", () => {
    const out = formatCompleteJson({
      account_metadata: { statement_period_start: "2024-01-01" },
    });
    expect(out).toContain("Period Start: 2024-01-01");
  });

  it("maps 'statement_period_end' to 'Period End'", () => {
    const out = formatCompleteJson({
      account_metadata: { statement_period_end: "2024-12-31" },
    });
    expect(out).toContain("Period End: 2024-12-31");
  });

  it("maps 'account_type' to 'Account Type'", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: "Individual" },
    });
    expect(out).toContain("Account Type: Individual");
  });
});