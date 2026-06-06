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

  it("treats mixed-case symbol variants as the same key and merges without data loss", () => {
    // Three holdings with identical symbols written in different cases.
    // normalizeHoldingSymbol uppercases each before mergeHoldingsBySymbol groups by Map key,
    // so all three must collapse to exactly one canonical entry ("TSYM").
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "tsym",
        name: "Test Asset Lower",
        quantity: 4,
        market_value: 400,
        cost_basis: 320,
        unrealized_gain_loss: 80,
      },
      {
        symbol: "TSYM",
        name: "Test Asset Upper",
        quantity: 6,
        market_value: 600,
        cost_basis: 480,
        unrealized_gain_loss: 120,
      },
      {
        symbol: "Tsym",
        name: "Test Asset Mixed",
        quantity: 2,
        market_value: 200,
        cost_basis: 160,
        unrealized_gain_loss: 40,
      },
    ]);

    // No duplicates and no dropped entries — all three folded into one.
    expect(consolidated).toHaveLength(1);

    const row = consolidated[0];
    expect(row.symbol).toBe("TSYM");

    // Numeric fields must be summed across all three inputs.
    expect(row.quantity).toBe(12);
    expect(row.market_value).toBe(1200);
    expect(row.cost_basis).toBe(960);
    expect(row.unrealized_gain_loss).toBe(240);

    // lots_count is the internal merge counter — must equal 3 to confirm no silent drops.
    expect(row.lots_count).toBe(3);

    // Derived ratio must still be computed correctly on the consolidated values.
    expect(row.unrealized_gain_loss_pct).toBeCloseTo((240 / 960) * 100, 8);
  });
 });