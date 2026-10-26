import { describe, expect, it } from "vitest";

import {
  consolidateHoldingsBySymbol,
  normalizeStoredPortfolio,
} from "@/lib/utils/portfolio-normalize";
import { groupHoldingPositions, prepareHoldingEntryEdit } from "@/lib/kai/holding-positions";
import type { Holding } from "@/components/kai/types/portfolio";

describe("entry-preserving position projection", () => {
  const entries: Holding[] = [
    { entry_id: "one", symbol: "AAPL", name: "Apple", quantity: 10, price: 130, market_value: 1300, cost_basis: 1000, acquisition_date: "2026-01-10" },
    { entry_id: "two", symbol: "AAPL", name: "Apple", quantity: 5, price: 130, market_value: 650, cost_basis: 600, acquisition_date: "2026-05-10" },
  ];
  it("retains original entries while producing one weighted position without mutating input", () => {
    const before = JSON.stringify(entries);
    const restored = normalizeStoredPortfolio(JSON.parse(JSON.stringify({ holdings: entries })), { preserveEntries: true });
    expect(restored.holdings).toHaveLength(2);
    const positions = groupHoldingPositions(restored.holdings as Holding[]);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ quantity: 15, market_value: 1950, cost_basis: 1600, unrealized_gain_loss: 350, price: 130 });
    expect(positions[0]!.cost_basis! / positions[0]!.quantity).toBeCloseTo(106.66667);
    expect(positions[0]!.entries.map(entry => entry.entry_id)).toEqual(["one", "two"]);
    expect(JSON.stringify(entries)).toBe(before);
  });
  it.each(["account_id", "currency", "instrument_kind", "position_side", "source_id", "security_id"] as const)("does not combine conflicting %s", field => {
    const rows = entries.map((entry, i) => ({ ...entry, [field]: i ? "second" : "first" }));
    expect(groupHoldingPositions(rows)).toHaveLength(2);
  });
  it("keeps partial cost/gain and mixed observed prices unavailable; excludes pending removals", () => {
    const partial = groupHoldingPositions([entries[0]!, { ...entries[1]!, cost_basis: undefined, price: 140 }])[0]!;
    expect(partial.cost_basis).toBeUndefined();
    expect(partial.unrealized_gain_loss).toBeUndefined();
    expect(partial.price_unavailable).toBe(true);
    const removed = groupHoldingPositions([entries[0]!, { ...entries[1]!, pending_delete: true }])[0]!;
    expect(removed.quantity).toBe(10);
    expect(removed.market_value).toBe(1300);
    expect(removed.entries).toHaveLength(2);
    const income = groupHoldingPositions([
      { ...entries[0]!, market_value: 100, estimated_annual_income: 10, est_yield: 10 },
      { ...entries[1]!, market_value: 1000, estimated_annual_income: 20, est_yield: 2 },
    ])[0]!;
    expect(income.estimated_annual_income).toBe(30);
    expect(income.est_yield).toBeCloseTo(30 / 1100 * 100);
    expect(partial.est_yield).toBeUndefined();
  });
  it("adds into the selected account even when another account owns the same stock, without carrying old security across ticker edits", () => {
    const rows = entries.map((entry, index) => ({ ...entry, security_id: "apple", account_id: "account-" + index }));
    const draft = { ...entries[0]!, quantity: 2, market_value: 260, entry_id: undefined };
    const added = prepareHoldingEntryEdit(draft, { ...rows[0]!, entry_id: undefined }, rows);
    expect(added).toMatchObject({ security_id: "apple", account_id: "account-0", quantity: 2 });
    expect(groupHoldingPositions([...rows, added]).map(position => position.entries.length)).toEqual([2, 1]);
    expect(prepareHoldingEntryEdit({ ...draft, symbol: "MSFT" }, rows[0], rows)).toMatchObject({ account_id: "account-0", security_id: undefined, identifier_type: "ticker" });
    expect(prepareHoldingEntryEdit(draft, null, rows).account_id).toBeUndefined();
    const otherAccount = [{ ...rows[1]!, symbol: "MSFT", security_id: "microsoft", source_id: "other-source" }];
    const changed = prepareHoldingEntryEdit({ ...draft, symbol: "MSFT" }, rows[0], otherAccount);
    expect(changed).toMatchObject({ account_id: "account-0", security_id: undefined });
    expect(changed.source_id).toBeUndefined();
  });
});

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
       it("parses formatted currency strings and parenthesized negatives in numeric fields", () => {
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "msft",
        name: "Microsoft",
        quantity: "10",
        market_value: "$1,200.50",
        cost_basis: "(200)",
      },
    ]);

    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].quantity).toBe(10);
    expect(consolidated[0].market_value).toBe(1200.5);
    expect(consolidated[0].cost_basis).toBe(-200);
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
});

// ── Circular reference safety — deep object traversal guard ──────────────────
//
// normalizeStoredPortfolio and consolidateHoldingsBySymbol both traverse
// holding objects using shallow spreads ({...row}) rather than recursive
// deep cloning. A circular reference in any extra holding property is copied
// by reference into the output without further traversal, so there is no risk
// of a call-stack overflow — the function must exit cleanly.
//
// Each test below:
//   1. Constructs a holding (or portfolio) object that contains a circular link.
//   2. Asserts the production function does NOT throw.
//   3. Asserts the normalized output carries the expected structural shape so
//      the caller can still use the result safely.

describe("portfolio normalizer — circular reference safety", () => {
  it("does not throw and correctly normalizes a holding that directly references itself", () => {
    const circularHolding: Record<string, unknown> = {
      symbol: "AAPL",
      name: "Apple Inc.",
      quantity: 10,
      market_value: 1_500,
      cost_basis: 1_200,
    };
    // circularHolding.self === circularHolding
    circularHolding.self = circularHolding;

    expect(() =>
      normalizeStoredPortfolio({ portfolio: { holdings: [circularHolding] } })
    ).not.toThrow();

    const normalized = normalizeStoredPortfolio({
      portfolio: { holdings: [circularHolding] },
    });

    expect(Array.isArray(normalized.holdings)).toBe(true);
    expect(normalized.holdings).toHaveLength(1);
    expect(normalized.holdings[0].symbol).toBe("AAPL");
    expect(normalized.holdings[0].quantity).toBe(10);
    expect(normalized.holdings[0].market_value).toBe(1_500);
  });

  it("does not throw when a holding carries a nested circular reference in a metadata property", () => {
    const holding: Record<string, unknown> = {
      symbol: "MSFT",
      name: "Microsoft",
      quantity: 5,
      market_value: 2_000,
    };
    // holding.meta.parent === holding — one-hop indirection
    const meta: Record<string, unknown> = { source: "statement" };
    meta.parent = holding;
    holding.meta = meta;

    expect(() => consolidateHoldingsBySymbol([holding])).not.toThrow();

    const consolidated = consolidateHoldingsBySymbol([holding]);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].symbol).toBe("MSFT");
    expect(consolidated[0].quantity).toBe(5);
  });

  it("does not throw when the portfolio object itself has a parent circular reference", () => {
    const portfolio: Record<string, unknown> = {
      holdings: [
        { symbol: "GOOG", name: "Alphabet", quantity: 2, market_value: 300 },
      ],
    };
    // portfolio.parent === portfolio
    portfolio.parent = portfolio;

    expect(() => normalizeStoredPortfolio({ portfolio })).not.toThrow();

    const normalized = normalizeStoredPortfolio({ portfolio });
    expect(Array.isArray(normalized.holdings)).toBe(true);
    expect(normalized.holdings).toHaveLength(1);
    expect(normalized.holdings[0].symbol).toBe("GOOG");
  });

  it("does not throw when analytics_v2 contains a self-referential circular node", () => {
    const circular: Record<string, unknown> = { label: "circular-analytics-node" };
    // circular.next === circular
    circular.next = circular;

    const raw = {
      portfolio: {
        holdings: [
          { symbol: "TSLA", name: "Tesla", quantity: 1, market_value: 250 },
        ],
        analytics_v2: circular,
      },
    };

    expect(() => normalizeStoredPortfolio(raw)).not.toThrow();

    const normalized = normalizeStoredPortfolio(raw);
    expect(Array.isArray(normalized.holdings)).toBe(true);
    expect(normalized.holdings[0].symbol).toBe("TSLA");
  });

  it("handles a batch of holdings where every entry carries its own circular reference without crashing or dropping rows", () => {
    function makeCircularHolding(
      symbol: string,
      quantity: number,
      marketValue: number
    ): Record<string, unknown> {
      const holding: Record<string, unknown> = {
        symbol,
        name: `Name for ${symbol}`,
        quantity,
        market_value: marketValue,
      };
      // Each holding references itself via a sentinel property
      holding.circular = holding;
      return holding;
    }

    const holdings = [
      makeCircularHolding("AMZN", 3, 1_200),
      makeCircularHolding("META", 7,   900),
      makeCircularHolding("NVDA", 2,   600),
    ];

    expect(() => consolidateHoldingsBySymbol(holdings)).not.toThrow();

    const consolidated = consolidateHoldingsBySymbol(holdings);
    expect(consolidated).toHaveLength(3);
    expect(consolidated.map((h) => h.symbol).sort()).toEqual(["AMZN", "META", "NVDA"]);
  });
});

describe("portfolio normalizer - mixed currency string boundaries", () => {
  it("defaults dirty alpha-numeric currency strings to safe numeric floors without throwing", () => {
    expect(() =>
      consolidateHoldingsBySymbol([
        {
          symbol: "MIX",
          name: "Mixed Currency Holding",
          quantity: "1",
          market_value: "1250.50INR",
          cost_basis: "450.00USD",
        },
      ])
    ).not.toThrow();

    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "MIX",
        name: "Mixed Currency Holding",
        quantity: "1",
        market_value: "1250.50INR",
        cost_basis: "450.00USD",
      },
    ]);

    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].quantity).toBe(1);
    expect(consolidated[0].market_value).toBe(0);
    expect(consolidated[0].cost_basis).toBeUndefined();
  });
});

describe("portfolio normalizer - negative currency boundaries", () => {
  it("safely preserves hard negative and sub-zero currency strings without producing NaN", () => {
    const consolidated = consolidateHoldingsBySymbol([
      {
        symbol: "LOSS",
        name: "Loss Position",
        quantity: "2",
        market_value: "-5400.22",
        cost_basis: "-0.0001",
      },
    ]);

    expect(consolidated).toHaveLength(1);
    expect(Number.isFinite(consolidated[0].market_value)).toBe(true);
    expect(Number.isFinite(consolidated[0].cost_basis)).toBe(true);
    expect(consolidated[0].market_value).toBeCloseTo(-5400.22, 8);
    expect(consolidated[0].cost_basis).toBeCloseTo(-0.0001, 8);
  });
});
