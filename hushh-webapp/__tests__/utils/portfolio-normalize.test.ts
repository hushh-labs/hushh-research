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
});
