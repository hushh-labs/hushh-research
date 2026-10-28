// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioAnalysis, PortfolioBriefing } from "@/components/kai/views/portfolio-briefing";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";

afterEach(cleanup);

describe("portfolio briefing", () => {
  it("shows an import entry when no portfolio is available", () => {
    const open = vi.fn();
    render(<PortfolioBriefing onOpen={open} />);
    expect(screen.getByText("Add a portfolio to see your analysis.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import portfolio" }));
    expect(open).toHaveBeenCalledOnce();
  });
  it("uses the actual largest position and reports unavailable history", () => {
    const model = mapPortfolioToDashboardViewModel({ total_value: 1000, holdings: [
      { symbol: "SMALL", name: "Smaller", quantity: 1, price: 100, market_value: 100 },
      { symbol: "LARGE", name: "Larger", quantity: 1, price: 900, market_value: 900 },
    ] });
    const open = vi.fn();
    const { unmount } = render(<PortfolioBriefing model={model} onOpen={open} />);
    expect(screen.getByText(/Larger is your largest tracked position at 90.0%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View analysis" }));
    expect(open).toHaveBeenCalledOnce();
    unmount();
    render(<PortfolioAnalysis model={model} source="Statement" />);
    expect(screen.getByText("Value history", { selector: "dt" }).nextElementSibling?.textContent).toBe("Unavailable");
    expect(screen.getByText(/Larger · 90.0%/)).toBeTruthy();
  });
});
