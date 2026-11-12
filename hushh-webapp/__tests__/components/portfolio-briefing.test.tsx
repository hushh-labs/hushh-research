// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioOverview } from "@/components/kai/views/portfolio-overview";
import { PortfolioAnalysis, PortfolioBriefing, SavedPortfolioBriefing } from "@/components/kai/views/portfolio-briefing";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";

afterEach(cleanup);

const reviewMocks = vi.hoisted(() => ({
  readCache: vi.fn(),
  readInput: vi.fn(),
  isCurrent: vi.fn(() => true),
  capture: vi.fn(),
}));

vi.mock("@/lib/finance-sharing/portfolio-review-cache", () => ({
  readSavedPortfolioReview: reviewMocks.readCache,
}));
vi.mock("@/lib/finance-sharing/portfolio-review-input", () => ({
  readPortfolioReviewInput: reviewMocks.readInput,
}));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({
  useFinanceShareContext: () => ({
    capture: reviewMocks.capture,
    ready: true,
    session: "owner:1",
  }),
}));

describe("portfolio briefing", () => {
  it("offers analysis when a saved score is unavailable", () => {
    const open = vi.fn();
    render(<PortfolioBriefing onOpen={open} />);
    expect(screen.getByText("Portfolio score")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View analysis" }));
    expect(open).toHaveBeenCalledOnce();
  });
  it("asks to complete the persona instead of a bare Unavailable", () => {
    render(<PortfolioBriefing onOpen={vi.fn()} missing="ability to absorb losses" />);
    expect(screen.getByText("Complete your persona")).toBeVisible();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
  it("computes a stock-decline scenario", () => {
    const model = mapPortfolioToDashboardViewModel({ total_value: 1000, holdings: [
      { symbol: "SMALL", name: "Smaller", quantity: 1, price: 100, market_value: 100 },
      { symbol: "LARGE", name: "Larger", quantity: 1, price: 900, market_value: 900, asset_type: "Common Stock" },
    ] });
    render(<PortfolioAnalysis model={model} />);
    expect(screen.queryByRole("heading", { name: "Balance history" })).toBeNull();
    expect(screen.getByText("Larger · 90.0% of portfolio")).toBeTruthy();
    expect(screen.getByText("−18.0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "−30%" }));
    expect(screen.getByText("−27.0%")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Largest holdings" })).toBeNull();
  });
  it("uses a Plaid equity holding for the scenario and excludes funds", () => {
    const model = mapPortfolioToDashboardViewModel({ total_value: 1000, holdings: [
      { symbol: "SBSI", name: "Southside Bancshares", quantity: 1, price: 291, market_value: 291, asset_type: "equity" },
      { symbol: "FUND", name: "Sample fund", quantity: 1, price: 420, market_value: 420, asset_type: "ETF" },
      { symbol: "CASH", name: "Cash", quantity: 1, price: 289, market_value: 289, asset_type: "Cash" },
    ] });
    render(<PortfolioAnalysis model={model} />);
    expect(screen.getByText("Southside Bancshares · 29.1% of portfolio")).toBeTruthy();
    expect(screen.getByText("−5.8%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "−30%" }));
    expect(screen.getByText("−8.7%")).toBeTruthy();
  });

  it("keeps the second card for a fund-and-cash portfolio without history", () => {
    const model = mapPortfolioToDashboardViewModel({ total_value: 1000, holdings: [
      { symbol: "FUND", name: "Sample fund", quantity: 1, price: 456, market_value: 456, asset_type: "ETF" },
      { symbol: "CASH", name: "Cash", quantity: 1, price: 544, market_value: 544, asset_type: "Cash" },
    ] });
    render(<PortfolioAnalysis model={model} />);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Portfolio mix", "What if your investments fall?",
    ]);
    expect(screen.getByText("−9.1%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "−30%" }));
    expect(screen.getByText("−13.7%")).toBeTruthy();
  });

  it("keeps both cards when figures are unavailable", () => {
    render(<PortfolioAnalysis />);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Portfolio mix", "Portfolio insights",
    ]);
    expect(screen.queryByText("Estimated portfolio change")).toBeNull();
  });

  it("shows saved positions and allocation without inventing performance contributions", () => {
    const portfolio = { total_value: 1000, holdings: [
      { symbol: "ABC", name: "Example", quantity: 1, price: 1000, market_value: 1000 },
    ] };
    const model = mapPortfolioToDashboardViewModel(portfolio);
    const open = vi.fn();
    render(<PortfolioOverview model={model} portfolio={portfolio} source="Statement" period="Saved snapshot" onOpenSection={open} />);
    expect(screen.getByText("Example")).toBeTruthy();
    const performance = within(screen.getByTestId("portfolio-performance"));
    expect(performance.getByText("Investment return").nextElementSibling?.textContent).toBe("Unavailable");
    expect(performance.getByText("Reported balance change").nextElementSibling?.textContent).toBe("Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "View performance" }));
    expect(open).toHaveBeenCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: "View allocation" }));
    expect(open).toHaveBeenCalledWith("allocation");
  });

  it.each([null, 0, -25])("keeps reported balance change %s distinct from investment return", change => {
    const portfolio = { total_value: 1000, account_summary: { cash_balance: 0, ...(change === null ? {} : { change_in_value: change }) }, holdings: [
      { symbol: "ABC", name: "Example", quantity: 1, price: 1000, market_value: 1000 },
    ], historical_values: [{ date: "2026-06-01", value: 900 }, { date: "2026-06-30", value: 1000 }] };
    const model = mapPortfolioToDashboardViewModel(portfolio);
    render(<PortfolioOverview model={model} portfolio={portfolio} source="Statement" period="Saved snapshot" onOpenSection={vi.fn()}
      briefing={<PortfolioBriefing onOpen={vi.fn()} />} />);
    const performance = within(screen.getByTestId("portfolio-performance"));
    expect(performance.getByText("Reported balance change").nextElementSibling?.textContent).toBe(change === null ? "Unavailable" : change === 0 ? "$0.00" : "-$25.00");
    expect(performance.getByText("Investment return").nextElementSibling?.textContent).toBe("Unavailable");
    expect(performance.getByText("Dated history").nextElementSibling?.textContent).toBe("Available");
  });

  it("shows a saved score and next step only for the matching portfolio", async () => {
    reviewMocks.capture.mockReturnValue({ userId: "owner", isCurrent: reviewMocks.isCurrent });
    reviewMocks.readCache.mockResolvedValue({
      digest: "current",
      review: { score: 0, next_step: "Check your cash needs." },
    });
    reviewMocks.readInput.mockImplementation(async (_context, source) => ({
      digest: source.snapshotId === "first" ? "current" : "stale",
    }));
    const open = vi.fn();
    const { rerender } = render(<SavedPortfolioBriefing source={{ kind: "statement", snapshotId: "first" }} onOpen={open} />);
    expect(await screen.findByText("Check your cash needs.")).toBeVisible();
    expect(screen.getByText("Portfolio score").nextElementSibling).toHaveTextContent("0 / 100");
    rerender(<SavedPortfolioBriefing source={{ kind: "statement", snapshotId: "second" }} onOpen={open} />);
    await waitFor(() => expect(reviewMocks.readInput).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner" }),
      expect.objectContaining({ snapshotId: "second" }),
    ));
    expect(screen.queryByText("Check your cash needs.")).toBeNull();
    expect(screen.getByText("Unavailable")).toBeVisible();
  });

});
