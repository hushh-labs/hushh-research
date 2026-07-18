import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IncomeDetailCard } from "@/components/kai/cards/income-detail-card";

describe("IncomeDetailCard", () => {
  it("covers the missing income value fallback", () => {
    const { container } = render(
      <IncomeDetailCard incomeSummary={{}} incomeDetail={{}} ytdMetrics={{}} />,
    );

    expect(screen.queryByText("Income")).toBeNull();
    expect(container.firstChild).toBeNull();
  });


 it("renders tax-exempt dividend details when they are the only detailed income values", () => {
  render(
    <IncomeDetailCard
      incomeSummary={{}}
      incomeDetail={{
        dividends_nontaxable: 125,
      }}
      ytdMetrics={{}}
    />,
   );

   expect(screen.getByText("Income")).toBeDefined();
   expect(screen.getByText("Tax-Exempt Dividends")).toBeDefined();
    expect(screen.getByText("$125.00")).toBeDefined();
  });
});
