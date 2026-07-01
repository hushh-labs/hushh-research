import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";

describe("PortfolioHistoryChart", () => {
  it("covers empty history fallback", () => {
    render(
      <PortfolioHistoryChart
        data={[]}
        beginningValue={10000}
        endingValue={12500}
        statementPeriod="Jan 1 - Jan 31"
      />,
    );

    expect(screen.getByText("Jan 1 - Jan 31")).toBeTruthy();
    expect(screen.getByText("Beginning Value")).toBeTruthy();
    expect(screen.getByText("$10,000.00")).toBeTruthy();
    expect(screen.getByText("Ending Value")).toBeTruthy();
    expect(screen.getByText("$12,500.00")).toBeTruthy();
    expect(screen.getByText("$2,500.00 (+25.00%)")).toBeTruthy();
  });
});
