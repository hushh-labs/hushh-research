// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioOverview } from "@/components/kai/views/portfolio-overview";
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
  it("shows when the score is unavailable and opens detailed holdings and history", () => {
    const model = mapPortfolioToDashboardViewModel({ total_value: 1000, holdings: [
      { symbol: "SMALL", name: "Smaller", quantity: 1, price: 100, market_value: 100 },
      { symbol: "LARGE", name: "Larger", quantity: 1, price: 900, market_value: 900 },
    ] });
    const open = vi.fn();
    const { unmount } = render(<PortfolioBriefing model={model} onOpen={open} />);
    expect(screen.getByRole("img", { name: "Net Worth Score unavailable" }).textContent).toBe("—");
    expect(screen.getByText("Cash share").nextElementSibling?.textContent).toBe("Unavailable");
    expect(screen.getByText("Tracked holdings · 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View analysis" }));
    expect(open).toHaveBeenCalledOnce();
    unmount();
    render(<PortfolioAnalysis model={model} />);
    expect(screen.queryByRole("heading", { name: "Balance history" })).toBeNull();
    expect(screen.getByText("Larger", { selector: "dt" }).nextElementSibling?.textContent).toBe("90.0%");
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
      briefing={<PortfolioBriefing model={model} portfolio={portfolio} />} />);
    const performance = within(screen.getByTestId("portfolio-performance"));
    expect(performance.getByText("Reported balance change").nextElementSibling?.textContent).toBe(change === null ? "Unavailable" : change === 0 ? "$0.00" : "-$25.00");
    expect(performance.getByText("Investment return").nextElementSibling?.textContent).toBe("Unavailable");
    expect(performance.getByText("Dated history").nextElementSibling?.textContent).toBe("Available");
    expect(screen.getByText("Cash share").nextElementSibling?.textContent).toBe("0.0%");
  });

  it("fills the ring from the linked score and only lists cash share beside it", () => {
    const portfolio = { total_value: 1000, account_summary: { cash_balance: 490 }, holdings: [] };
    const model = mapPortfolioToDashboardViewModel(portfolio);
    render(<PortfolioBriefing model={model} portfolio={portfolio} linkedNetWorthScore={{
      score: 28, linked_net_worth_usd: -72_000, country_on_file: "US", unavailable_reason: null,
    }} />);
    const ring = screen.getByRole("meter", { name: "Net Worth Score" });
    expect(ring.textContent).toBe("28");
    expect(ring.style.getPropertyValue("--nws-progress")).toBe("2.8%");
    expect(screen.getByText("NWS score")).toBeTruthy();
    expect(screen.getAllByRole("term").map((item) => item.textContent)).toEqual(["Cash share"]);
    expect(screen.getByText("49.0%")).toBeTruthy();
  });

});
