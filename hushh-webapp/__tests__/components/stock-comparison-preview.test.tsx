import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StockComparisonPreview } from "@/components/kai/cards/stock-comparison-preview";

describe("StockComparisonPreview", () => {
  it("covers empty comparison state", () => {
    render(<StockComparisonPreview preview={null} onStartDebate={vi.fn()} />);

    expect(screen.getByText("Compare before debate")).toBeTruthy();
    expect(
      screen.getByText("Kai is preparing a live quote and list comparison."),
    ).toBeTruthy();
  });
});
