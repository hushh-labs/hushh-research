import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on the empty / zero-valued payload edge cases. This formatter had no
// direct unit coverage. The assertions document the *actual* behavior:
//   - zero numeric currency fields format as "$0.00" (not dropped, not "N/A")
//   - zero percentage fields format as "+0.00%"
//   - null / undefined sections are skipped entirely
//   - empty arrays are skipped (no header emitted)
//   - null / undefined fields inside an object section are skipped

describe("formatCompleteJson — empty and zero-valued payloads", () => {
  it("returns an empty string for an empty object", () => {
    expect(formatCompleteJson({})).toBe("");
  });

  it("formats zero-valued currency fields as $0.00 instead of dropping them", () => {
    const output = formatCompleteJson({
      portfolio_summary: {
        beginning_value: 0,
        ending_value: 0,
      },
    });

    expect(output).toContain("--- Portfolio Summary ---");
    expect(output).toContain("Beginning Value: $0.00");
    expect(output).toContain("Ending Value: $0.00");
  });

  it("formats a zero percentage field as +0.00%", () => {
    const output = formatCompleteJson({
      portfolio_summary: {
        // est_yield is a registered percentage field
        est_yield: 0,
      },
    });

    expect(output).toContain("Yield: +0.00%");
  });

  it("skips null and undefined top-level sections", () => {
    const output = formatCompleteJson({
      portfolio_summary: null,
      cash_management: undefined as unknown as Record<string, unknown>,
      ytd_metrics: { total_value: 0 },
    });

    expect(output).not.toContain("Portfolio Summary");
    expect(output).not.toContain("Cash Management");
    expect(output).toContain("--- Year-to-Date Metrics ---");
    expect(output).toContain("Total Portfolio Value: $0.00");
  });

  it("skips empty arrays without emitting a section header", () => {
    const output = formatCompleteJson({
      holdings: [],
      activity_and_transactions: [],
    });

    expect(output).toBe("");
  });

  it("skips null and undefined fields inside an object section", () => {
    const output = formatCompleteJson({
      account_metadata: {
        institution_name: "Acme Bank",
        account_holder: null,
        account_number: undefined,
      },
    });

    expect(output).toContain("Institution: Acme Bank");
    expect(output).not.toContain("Account Holder");
    expect(output).not.toContain("Account Number");
  });
});
