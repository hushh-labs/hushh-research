import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingDetailsDrawer } from "@/components/kai/holdings/holding-details-drawer";
import type { HoldingMobileCardViewModel } from "@/components/kai/holdings/holding-mobile-card";

const holding: HoldingMobileCardViewModel = {
  id: "holding-aapl",
  symbol: "AAPL",
  name: "Apple Inc.",
  marketValue: 12000,
  shares: 24,
  gainLossValue: 250,
  gainLossPct: 2.5,
  averagePrice: 180,
  currentPrice: 190,
  portfolioWeightPct: 12.5,
  sector: "Technology",
  isCash: false,
  pendingDelete: false,
};

describe("HoldingDetailsDrawer", () => {
  it("covers close control button type", () => {
    render(
      <HoldingDetailsDrawer
        open
        holding={holding}
        onOpenChange={vi.fn()}
        onEdit={vi.fn()}
        onToggleDelete={vi.fn()}
      />,
    );

    const closeButton = screen.getByRole("button", {
      name: "Close holding details",
    }) as HTMLButtonElement;

    expect(closeButton.type).toBe("button");
  });
});
