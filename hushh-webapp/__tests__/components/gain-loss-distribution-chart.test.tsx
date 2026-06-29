import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GainLossDistributionChart } from "@/components/kai/charts/gain-loss-distribution-chart";

describe("GainLossDistributionChart", () => {
  it("covers empty distribution fallback", () => {
    render(<GainLossDistributionChart data={[]} />);

    expect(screen.getByText("Gain/Loss Distribution")).toBeTruthy();
    expect(
      screen.getByText("No gain/loss distribution data available."),
    ).toBeTruthy();
  });
});
