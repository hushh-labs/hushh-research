import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewHoldingCtaCard } from "@/components/kai/cards/new-holding-cta-card";

describe("NewHoldingCtaCard", () => {
  it("renders add holding action with explicit button type", () => {
    render(
      <NewHoldingCtaCard
        onAddHolding={vi.fn()}
        onImportStatement={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add Holding" }).getAttribute("type"),
    ).toBe("button");
  });
});
