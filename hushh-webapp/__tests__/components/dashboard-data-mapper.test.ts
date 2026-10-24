import { describe, expect, it } from "vitest";

import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { buildPortfolioSharePayloadFromDashboardModel, generatePortfolioReportPdf } from "@/lib/portfolio-share/client";
import { overviewFacts } from "@/components/kai/views/portfolio-display-facts";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";
import type { PortfolioData } from "@/components/kai/types/portfolio";

const portfolioFixture: PortfolioData = {
  account_info: {
    statement_period_start: "2026-06-01",
    statement_period_end: "2026-06-30",
  },
  account_summary: {
    beginning_value: 100_000,
    ending_value: 110_000,
  },
  holdings: [
    {
      symbol: "AAPL",
      name: "Apple Inc.",
      quantity: 100,
      price: 1100,
      market_value: 110_000,
      cost_basis: 100_000,
      is_investable: true,
      is_sec_common_equity_ticker: true,
    },
  ],
};

describe("mapPortfolioToDashboardViewModel history", () => {
  it("does not fabricate a performance line from statement endpoints", () => {
    const model = mapPortfolioToDashboardViewModel(portfolioFixture);

    expect(model.history).toEqual([]);
    expect(model.quality.historyReady).toBe(false);
    expect(buildPortfolioSharePayloadFromDashboardModel(model).performance).toEqual([]);
  });

  it("does not treat a partial or invalid history payload as a chartable series", () => {
    const model = mapPortfolioToDashboardViewModel({
      ...portfolioFixture,
      historical_values: [
        { date: "2026-06-30", value: 110_000 },
        { date: "not-a-date", value: 108_000 },
      ],
    });

    expect(model.history).toEqual([]);
    expect(model.quality.historyReady).toBe(false);
  });

  it("keeps a genuine provider-backed historical series", () => {
    const model = mapPortfolioToDashboardViewModel({
      ...portfolioFixture,
      historical_values: [
        { date: "2026-06-01", value: 100_000 },
        { date: "2026-06-15", value: 104_000 },
        { date: "2026-06-30", value: 110_000 },
      ],
    });

    expect(model.history).toEqual([
      { date: "2026-06-01", value: 100_000 },
      { date: "2026-06-15", value: 104_000 },
      { date: "2026-06-30", value: 110_000 },
    ]);
    expect(model.quality.historyReady).toBe(true);
  });
});


describe("Portfolio display evidence", () => {
  it("keeps absent balances and cost basis unavailable instead of measured zero", () => {
    const portfolio: PortfolioData = { account_summary: { ending_value: 100 }, holdings: [{ symbol: "TEST", name: "Test", market_value: 100, price: 10, quantity: 10 }] };
    const facts = overviewFacts(mapPortfolioToDashboardViewModel(portfolio), portfolio);
    expect(facts).toMatchObject({ invested: 100, cash: null, change: null, changePct: null });
    const holding = toHoldingViewModel({ ...portfolio.holdings![0]!, client_id: "test" }, 100);
    expect(holding).toMatchObject({ costBasis: null, averagePrice: null, gainLossValue: null, gainLossPct: null });
    const measured = { ...portfolio, account_summary: { beginning_value: 0, ending_value: 100 }, cash_balance: 0 };
    expect(overviewFacts(mapPortfolioToDashboardViewModel(measured), measured)).toMatchObject({ cash: 0, change: 100, changePct: null });
    expect(toHoldingViewModel({ ...portfolio.holdings![0]!, cost_basis: 0, client_id: "test" }, 100)).toMatchObject({ costBasis: 0, averagePrice: 0, gainLossValue: 100, gainLossPct: null });
  });

  it("prefers explicit cash positions and reports balance change separately from returns", () => {
    const portfolio: PortfolioData = { account_summary: { beginning_value: 80, ending_value: 100, change_in_value: 15, cash_balance: 40 }, cash_balance: 50,
      holdings: [{ symbol: "TEST", name: "Test", market_value: 80, quantity: 8, price: 10 }, { symbol: "CASH", name: "Cash", market_value: 20, quantity: 20, price: 1, is_cash_equivalent: true }] };
    expect(overviewFacts(mapPortfolioToDashboardViewModel(portfolio), portfolio)).toMatchObject({ invested: 80, cash: 20, change: 15, changePct: 18.75 });
  });
});


it("exports unavailable change and real history provenance consistently with the report preview", async () => {
  const model = mapPortfolioToDashboardViewModel({ account_summary: { ending_value: 100 } });
  const blob = await generatePortfolioReportPdf(buildPortfolioSharePayloadFromDashboardModel(model), { source: "Statement", period: "October 2026", change: null, changePct: null });
  const pdf = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
  expect(pdf).toContain("Period balance change unavailable");
  expect(pdf).toContain("Statement");
  expect(pdf).toContain("October 2026");
  expect(pdf).not.toContain("+$0.00");
});
