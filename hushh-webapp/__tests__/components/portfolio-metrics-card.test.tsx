import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PortfolioMetricsCard } from "@/components/kai/cards/portfolio-metrics-card";

describe("PortfolioMetricsCard", () => {
  it("renders metric value fallback when cost basis is missing", () => {
    render(
      <PortfolioMetricsCard
        totalValue={1000}
        holdings={[
          {
            symbol: "AAPL",
            name: "Apple Inc.",
            market_value: 1000,
            sector: "Technology",
          },
        ]}
      />,
    );

    expect(screen.getByText("Cost Basis")).toBeTruthy();
    expect(screen.getByText("$0")).toBeTruthy();
  });
});
