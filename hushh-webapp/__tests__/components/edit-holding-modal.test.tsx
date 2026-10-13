import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => [],
  preloadTickerUniverse: () => Promise.resolve([]),
  searchTickerUniverse: () => [],
  searchTickerUniverseRemote: () => Promise.resolve([]),
}));

describe("EditHoldingModal", () => {
  it("covers submit button type", () => {
    render(
      <EditHoldingModal
        isOpen
        holding={{
          symbol: "AAPL",
          name: "Apple Inc.",
          quantity: 10,
          price: 190,
          market_value: 1900,
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const submitButton = screen.getByRole("button", {
      name: /save changes/i,
    }) as HTMLButtonElement;

    expect(submitButton.type).toBe("button");
  });
});
