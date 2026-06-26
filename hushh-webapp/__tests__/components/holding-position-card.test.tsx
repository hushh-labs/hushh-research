import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingPositionCard } from "@/components/kai/cards/holding-position-card";

describe("HoldingPositionCard", () => {
  it("renders action buttons with explicit button type", () => {
    render(
      <HoldingPositionCard
        holding={{
          symbol: "AAPL",
          name: "Apple Inc.",
          quantity: 10,
          price: 190,
          marketValue: 1900,
          gainLossValue: 120,
          gainLossPct: 6.74,
        }}
        onAnalyze={vi.fn()}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit AAPL" }).getAttribute("type")).toBe(
      "button",
    );
    expect(screen.getByRole("button", { name: "Delete AAPL" }).getAttribute("type")).toBe(
      "button",
    );
    expect(screen.getByRole("button", { name: "Connect Kai" }).getAttribute("type")).toBe(
      "button",
    );
  });
});
