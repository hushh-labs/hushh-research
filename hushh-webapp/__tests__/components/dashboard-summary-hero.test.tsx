import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DashboardSummaryHero } from "@/components/kai/cards/dashboard-summary-hero";

describe("DashboardSummaryHero", () => {
  it("renders metric labels", () => {
    render(
      <DashboardSummaryHero
        totalValue={125000}
        netChange={3200}
        changePct={2.63}
        holdingsCount={12}
        riskLabel="aggressive"
        brokerageName="Plaid"
        periodRange="January 2026"
        beginningBalance={121800}
      />,
    );

    expect(screen.getByText("Total portfolio value")).toBeTruthy();
    expect(screen.getByText("Risk: Aggressive")).toBeTruthy();
    expect(screen.getByText("Holdings: 12")).toBeTruthy();
    expect(screen.getByText("Beginning Balance:")).toBeTruthy();
  });
});
