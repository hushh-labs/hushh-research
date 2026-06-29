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
});
