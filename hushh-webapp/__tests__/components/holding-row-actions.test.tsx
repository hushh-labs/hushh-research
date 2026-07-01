import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingRowActions } from "@/components/kai/holdings/holding-row-actions";

describe("HoldingRowActions", () => {
  it("covers menu trigger accessible label", () => {
    render(
      <HoldingRowActions
        layout="row"
        symbol="AAPL"
        onEdit={vi.fn()}
        onToggleDelete={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Holding actions for AAPL" }),
    ).toBeTruthy();
  });
});
