import { describe, expect, it } from "vitest";

import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
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
