import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarketOverviewGrid } from "@/components/kai/cards/market-overview-grid";

describe("MarketOverviewGrid", () => {
  it("covers empty market data fallback", () => {
    render(<MarketOverviewGrid metrics={[]} />);

    expect(
      screen.getByText("Market overview metrics are not available at the moment."),
    ).toBeTruthy();
  });
});
