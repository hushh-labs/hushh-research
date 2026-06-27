import { describe, expect, it } from "vitest";

import {
  collectAccounts,
  consolidateFinancialPortfolio,
  dedupAccountsByFreshest,
} from "@/lib/services/one-kyc-financial-consolidation";

describe("collectAccounts", () => {
  it("treats a single portfolio object as one account", () => {
    const collected = collectAccounts({
      account_info: { brokerage_name: "Fidelity", account_type: "Individual TOD" },
      account_summary: { ending_value: 1000, cash_balance: 50 },
      holdings: [{ symbol: "AAPL", quantity: 10, market_value: 900 }],
    });
    expect(collected).toHaveLength(1);
    expect(collected[0]!.account.label).toBe("Fidelity Individual TOD");
    expect(collected[0]!.account.endingValue).toBe(1000);
    expect(collected[0]!.account.cashBalance).toBe(50);
    expect(collected[0]!.holdings).toHaveLength(1);
  });

  it("expands an accounts[] array into one entry per account", () => {
    const collected = collectAccounts({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
          account_summary: { ending_value: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 900 }],
          generated_at: "2026-01-31T00:00:00Z",
        },
        {
          account_info: { brokerage_name: "Schwab", account_type: "IRA" },
          account_summary: { ending_value: 2000 },
          holdings: [{ symbol: "AAPL", quantity: 200, market_value: 1800 }],
          generated_at: "2026-02-15T00:00:00Z",
        },
      ],
    });
    expect(collected).toHaveLength(2);
    expect(collected.map((c) => c.account.label)).toEqual([
      "Fidelity Individual",
      "Schwab IRA",
    ]);
  });
});

describe("dedupAccountsByFreshest", () => {
  it("keeps the freshest copy of a duplicated account by generatedAt", () => {
    const collected = collectAccounts({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "IRA", account_number: "X1" },
          account_summary: { ending_value: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 900 }],
          generated_at: "2026-01-31T00:00:00Z",
        },
        {
          account_info: { brokerage_name: "Fidelity", account_type: "IRA", account_number: "X1" },
          account_summary: { ending_value: 1100 },
          holdings: [{ symbol: "AAPL", quantity: 110, market_value: 990 }],
          generated_at: "2026-02-28T00:00:00Z",
        },
      ],
    });
    const deduped = dedupAccountsByFreshest(collected);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.account.endingValue).toBe(1100);
    expect(deduped[0]!.account.generatedAt).toBe("2026-02-28T00:00:00Z");
  });

  it("keeps accounts with no identity key distinct", () => {
    const collected = collectAccounts({
      accounts: [
        { account_summary: { ending_value: 1 }, holdings: [] },
        { account_summary: { ending_value: 2 }, holdings: [] },
      ],
    });
    expect(dedupAccountsByFreshest(collected)).toHaveLength(2);
  });
});

describe("consolidateFinancialPortfolio", () => {
  it("merges multiple lots of the same security into one position", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { symbol: "AAPL", quantity: 100, market_value: 15000, cost_basis: 10000, unrealized_gain_loss: 5000 },
        { symbol: "AAPL", quantity: 50, market_value: 7500, cost_basis: 6000, unrealized_gain_loss: 1500 },
      ],
    });
    expect(result).not.toBeNull();
    const aapl = result!.holdings.find((h) => h.symbol === "AAPL")!;
    expect(Number(aapl.quantity)).toBe(150);
    expect(Number(aapl.market_value)).toBe(22500);
    expect(Number(aapl.unrealized_gain_loss)).toBe(6500);
    expect(result!.netUnrealizedGainLoss).toBe(6500);
  });

  it("merges the same security across accounts and sums per-account statement totals", () => {
    const result = consolidateFinancialPortfolio({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
          account_summary: { ending_value: 100000, cash_balance: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 15000 }],
        },
        {
          account_info: { brokerage_name: "Schwab", account_type: "IRA" },
          account_summary: { ending_value: 50000, cash_balance: 500 },
          holdings: [{ symbol: "AAPL", quantity: 200, market_value: 30000 }],
        },
      ],
    });
    expect(result!.accounts).toHaveLength(2);
    expect(result!.totalValue).toBe(150000); // statement-authoritative: 100000 + 50000
    expect(result!.cashBalance).toBe(1500);
    const aapl = result!.holdings.find((h) => h.symbol === "AAPL")!;
    expect(Number(aapl.quantity)).toBe(300);
    expect(Number(aapl.market_value)).toBe(45000);
  });

  it("prefers the statement total over the summed holdings (statement-authoritative)", () => {
    const result = consolidateFinancialPortfolio({
      account_summary: { ending_value: 500000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(result!.totalValue).toBe(500000);
    expect(result!.holdingsSum).toBe(100000);
  });

  it("flags a reconciliation mismatch only when totals diverge beyond tolerance", () => {
    const mismatched = consolidateFinancialPortfolio({
      account_summary: { ending_value: 500000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(mismatched!.reconciliationMismatch).toBe(true);

    const consistent = consolidateFinancialPortfolio({
      account_summary: { ending_value: 100000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(consistent!.reconciliationMismatch).toBe(false);
  });

  it("uses asset_allocation from the data when present", () => {
    const result = consolidateFinancialPortfolio({
      asset_allocation: [
        { bucket: "equity", value: 80, pct: 80 },
        { bucket: "cash_equivalent", value: 20, pct: 20 },
      ],
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100 }],
    });
    expect(result!.allocation).toEqual([
      { bucket: "equity", pct: 80 },
      { bucket: "cash_equivalent", pct: 20 },
    ]);
  });

  it("computes allocation from holdings when asset_allocation is absent", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { symbol: "AAPL", quantity: 1, market_value: 800, instrument_kind: "equity" },
        { symbol: "GOVT", quantity: 1, market_value: 200, instrument_kind: "fixed_income" },
      ],
    });
    const buckets = Object.fromEntries(result!.allocation.map((s) => [s.bucket, Math.round(s.pct)]));
    expect(buckets.equity).toBe(80);
    expect(buckets.fixed_income).toBe(20);
  });

  it("never drops a name-only holding (synthesizes a symbol from the name)", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { name: "US TREASURY 2.5% 2030", quantity: 1, market_value: 1000 },
      ],
    });
    expect(result!.holdings).toHaveLength(1);
    expect(Number(result!.holdings[0]!.market_value)).toBe(1000);
  });

  it("returns null for non-portfolio input", () => {
    expect(consolidateFinancialPortfolio("nope")).toBeNull();
    expect(consolidateFinancialPortfolio(123)).toBeNull();
  });

  it("keeps a ticker-only holding (no symbol field) and resolves its symbol from ticker", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [{ ticker: "AAPL", quantity: 10, market_value: 1500 }],
    });
    expect(result!.holdings).toHaveLength(1);
    expect(result!.holdings[0]!.symbol).toBe("AAPL");
    expect(Number(result!.holdings[0]!.market_value)).toBe(1500);
  });

  it("keeps a security_symbol-only holding and resolves its symbol", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [{ security_symbol: "MSFT", quantity: 5, market_value: 2000 }],
    });
    expect(result!.holdings).toHaveLength(1);
    expect(result!.holdings[0]!.symbol).toBe("MSFT");
  });

  it("does not alter a holding that already has a symbol", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [{ symbol: "AAPL", ticker: "IGNORED", quantity: 10, market_value: 1500 }],
    });
    expect(result!.holdings).toHaveLength(1);
    expect(result!.holdings[0]!.symbol).toBe("AAPL");
  });
});
