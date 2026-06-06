import { describe, expect, it } from "vitest";

import {
  consolidateHoldingsBySymbol,
  normalizeStoredPortfolio,
} from "@/lib/utils/portfolio-normalize";

describe("portfolio normalize helpers", () => {
  it("consolidates duplicate symbols using weighted price and summed totals", () => {
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "aapl",
        name: "Apple",
        quantity: 10,
        market_value: 1500,
        cost_basis: 1200,
        unrealized_gain_loss: 300,
      },
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 5,
        market_value: 800,
        cost_basis: 700,
        unrealized_gain_loss: 100,
      },
    ]);

    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].symbol).toBe("AAPL");
    expect(consolidated[0].quantity).toBe(15);
    expect(consolidated[0].market_value).toBe(2300);
    expect(consolidated[0].cost_basis).toBe(1900);
    expect(consolidated[0].unrealized_gain_loss).toBe(400);
    expect(consolidated[0].price).toBeCloseTo(2300 / 15, 8);
  });

  it("normalizes stored portfolio holdings and removes symbol duplicates", () => {
    const normalized = normalizeStoredPortfolio({
      portfolio: {
        holdings: [
          {
            symbol: "QACDS",
            name: "Cash Sweep",
            quantity: 1,
            market_value: 500,
          },
          {
            symbol: "CASH",
            name: "Brokerage Cash",
            quantity: 2,
            market_value: 300,
          },
        ],
      },
    });

    expect(Array.isArray(normalized.holdings)).toBe(true);
    expect(normalized.holdings).toHaveLength(1);
    expect(normalized.holdings[0].symbol).toBe("CASH");
    expect(normalized.holdings[0].market_value).toBe(800);
    expect(normalized.holdings[0].quantity).toBe(3);
  });
       it("drops empty symbol holdings during consolidation", () => {
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "",
        name: "Unknown Holding",
        quantity: 10,
        market_value: 100,
      },
    ]);

    expect(consolidated).toHaveLength(0);
  });

  it("guards divide-by-zero: emits 0 price and skips pct fields when quantity and cost_basis are zero", () => {
    // Exercises the two arithmetic guards in mergeHoldingsBySymbol's post-consolidation loop:
    //   price = marketValue / quantity  → skipped when Math.abs(quantity) <= 1e-9
    //   unrealized_gain_loss_pct = unrealized / costBasis  → skipped when Math.abs(costBasis) <= 1e-6
    // Both must produce 0 / undefined, never NaN or Infinity.
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "TZERO",
        name: "Test Zero Asset",
        quantity: 0,
        market_value: 0,
        cost_basis: 0,
        unrealized_gain_loss: 0,
      },
    ]);

    expect(consolidated).toHaveLength(1);
    const row = consolidated[0];

    // price must be 0 (not NaN and not Infinity) — the division guard fired correctly.
    expect(row.price).toBe(0);
    expect(Number.isNaN(row.price)).toBe(false);
    expect(Number.isFinite(row.price)).toBe(true);

    // pct fields must be omitted entirely rather than set to Infinity / NaN.
    expect(row.unrealized_gain_loss_pct).toBeUndefined();
    expect(row.est_yield).toBeUndefined();
  });

  it("defaults total_value to 0 without NaN when holdings array is empty", () => {
    // Exercises the reduce() accumulator path in normalizeStoredPortfolio:
    //   total_value = holdings.reduce((sum, row) => sum + market_value, 0)
    // An empty reduce must yield the safe initial value 0, not undefined or NaN.
    // Also validates that account_info (org-tracking fields) survives an empty-holdings run.
    const normalized = normalizeStoredPortfolio({
      portfolio: {
        account_info: { holder_name: "test_org_name", brokerage: "test_brokerage_id" },
        holdings: [],
      },
    });

    expect(Array.isArray(normalized.holdings)).toBe(true);
    expect(normalized.holdings).toHaveLength(0);

    // total_value must be 0, not NaN — the reduce initial value guard is in place.
    expect(normalized.total_value).toBe(0);
    expect(Number.isNaN(normalized.total_value)).toBe(false);

    // Org-tracking account fields must be preserved even when holdings is empty.
    expect(normalized.account_info?.holder_name).toBe("test_org_name");
    expect(normalized.account_info?.brokerage).toBe("test_brokerage_id");
  });
 });