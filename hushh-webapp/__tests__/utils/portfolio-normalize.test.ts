import { describe, expect, it } from "vitest";

import {
  consolidateHoldingsBySymbol,
  mergeWithExistingHoldings,
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

describe("mergeWithExistingHoldings", () => {
  it("retains existing holdings not present in new import", () => {
    const result = mergeWithExistingHoldings(
      [
        { symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500, cost_basis: 1200 },
        { symbol: "MSFT", name: "Microsoft", quantity: 5, market_value: 2000, cost_basis: 1800 },
      ],
      [
        { symbol: "AAPL", name: "Apple Inc.", quantity: 10, market_value: 1700, cost_basis: 1400 },
      ]
    );

    expect(result.holdings).toHaveLength(2);
    expect(result.retained).toEqual(["MSFT"]);
    expect(result.averaged).toEqual(["AAPL"]);
    expect(result.added).toEqual([]);

    const msft = result.holdings.find((h) => h.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.quantity).toBe(5);
    expect(msft!.market_value).toBe(2000);
  });

  it("averages cost basis per share for duplicate symbols", () => {
    // Existing: 10 shares at $120/share cost basis ($1200 total)
    // New: 10 shares at $140/share cost basis ($1400 total)
    // Average per-share cost: ($120 + $140) / 2 = $130
    // Averaged total cost basis at new qty (10): $1300
    const result = mergeWithExistingHoldings(
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500, cost_basis: 1200 }],
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1700, cost_basis: 1400 }]
    );

    expect(result.holdings).toHaveLength(1);
    expect(result.averaged).toEqual(["AAPL"]);
    const aapl = result.holdings[0];
    expect(aapl.cost_basis).toBeCloseTo(1300, 2);
    // unrealized = market_value - cost_basis = 1700 - 1300 = 400
    expect(aapl.unrealized_gain_loss).toBeCloseTo(400, 2);
    // market_value comes from new import
    expect(aapl.market_value).toBe(1700);
  });

  it("adds new holdings not present in existing", () => {
    const result = mergeWithExistingHoldings(
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500 }],
      [{ symbol: "NVDA", name: "NVIDIA", quantity: 5, market_value: 3000, cost_basis: 2500 }]
    );

    expect(result.holdings).toHaveLength(2);
    expect(result.added).toEqual(["NVDA"]);
    expect(result.retained).toEqual(["AAPL"]);
    expect(result.averaged).toEqual([]);
  });

  it("handles empty existing holdings", () => {
    const result = mergeWithExistingHoldings(
      [],
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500 }]
    );

    expect(result.holdings).toHaveLength(1);
    expect(result.added).toEqual(["AAPL"]);
    expect(result.retained).toEqual([]);
    expect(result.averaged).toEqual([]);
  });

  it("handles empty new holdings by retaining all existing", () => {
    const result = mergeWithExistingHoldings(
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500 }],
      []
    );

    expect(result.holdings).toHaveLength(1);
    expect(result.retained).toEqual(["AAPL"]);
    expect(result.added).toEqual([]);
    expect(result.averaged).toEqual([]);
  });

  it("handles undefined inputs gracefully", () => {
    const result = mergeWithExistingHoldings(undefined, undefined);
    expect(result.holdings).toHaveLength(0);
  });

  it("uses new cost basis when existing has no cost basis", () => {
    const result = mergeWithExistingHoldings(
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1500 }],
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1700, cost_basis: 1400 }]
    );

    const aapl = result.holdings[0];
    expect(aapl.cost_basis).toBe(1400);
  });

  it("falls back to new cost basis when existing quantity is zero", () => {
    const result = mergeWithExistingHoldings(
      [{ symbol: "AAPL", name: "Apple", quantity: 0, market_value: 0, cost_basis: 500 }],
      [{ symbol: "AAPL", name: "Apple", quantity: 10, market_value: 1700, cost_basis: 1400 }]
    );

    const aapl = result.holdings[0];
    // existPerShare is 0 (qty=0), so avgPerShare falls through to newCostBasis
    expect(aapl.cost_basis).toBe(1400);
    expect(aapl.quantity).toBe(10);
    expect(result.averaged).toEqual(["AAPL"]);
  });
});
