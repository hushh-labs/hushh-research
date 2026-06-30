import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TopMoversCard } from "@/components/kai/cards/top-movers-card";

describe("TopMoversCard", () => {
  it("renders mover list items", () => {
    render(
      <TopMoversCard
        holdings={[
          {
            symbol: "NVDA",
            name: "Nvidia",
            market_value: 1200,
            unrealized_gain_loss_pct: 4.25,
          },
          {
            symbol: "TSLA",
            name: "Tesla",
            market_value: 800,
            unrealized_gain_loss_pct: -2.5,
          },
        ]}
      />,
    );

    expect(screen.getByText("Gainers")).toBeTruthy();
    expect(screen.getByText("NVDA")).toBeTruthy();
    expect(screen.getByText("+4.25%")).toBeTruthy();
    expect(screen.getByText("Losers")).toBeTruthy();
    expect(screen.getByText("TSLA")).toBeTruthy();
    expect(screen.getByText("-2.50%")).toBeTruthy();
  });
});
