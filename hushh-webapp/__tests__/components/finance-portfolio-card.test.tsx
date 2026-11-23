import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FinancePortfolioCard } from "@/components/agent/finance-portfolio-card";

const state = vi.hoisted(() => ({ unlocked: false, resource: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: state.unlocked, vaultKey: "key", vaultOwnerToken: "token" }),
}));
vi.mock("@/lib/kai/kai-financial-resource", () => ({ useKaiFinancialResource: state.resource }));
vi.mock("@/components/kai/charts/portfolio-allocation-bar", () => ({ PortfolioAllocationBar: () => null }));
vi.mock("@/components/kai/charts/portfolio-history-chart", () => ({ PortfolioHistoryChart: () => null }));
vi.mock("@/components/kai/performance/performance-strip", () => ({ PerformanceStrip: () => null }));

describe("Finance portfolio card", () => {
  it("blocks protected information while locked", () => {
    state.unlocked = false;
    state.resource.mockReturnValue({ data: null, loading: false });
    render(<FinancePortfolioCard section="holdings" />);
    const details = screen.getByText("Holdings").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("Sign in and unlock your vault to view your portfolio.")).toBeVisible();
    expect(state.resource).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("does not present inactive sources when no statement is selected", () => {
    state.unlocked = true;
    state.resource.mockReturnValue({ loading: false, data: {
      activePortfolio: null, activeSource: "statement", activeStatementSnapshotId: null,
      statementSnapshots: [], availableSources: ["statement", "plaid"], freshness: null,
    } });
    render(<FinancePortfolioCard section="sources" />);
    const details = screen.getByText("Portfolio sources").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("No portfolio source available.")).toBeVisible();
    expect(screen.queryByText(/available sources|linked accounts/i)).toBeNull();
  });

  it("shows only the selected statement name and upload time", () => {
    state.unlocked = true;
    const importedAt = "2026-11-20T11:32:00.000Z";
    state.resource.mockReturnValue({ loading: false, data: {
      activeSource: "statement", activeStatementSnapshotId: "selected",
      statementSnapshots: [
        { id: "newest", fileName: "Newer statement.pdf" },
        { id: "selected", fileName: "November statement.pdf", importedAt, label: "Broker · 2026-09-30" },
      ],
      availableSources: ["statement", "plaid"], freshness: { lastSyncedAt: importedAt },
    } });
    render(<FinancePortfolioCard section="sources" />);
    const details = screen.getByText("Portfolio sources").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("November statement.pdf")).toBeVisible();
    expect(details.querySelector("time")).toHaveAttribute("datetime", importedAt);
    expect(screen.queryByText(/newer statement|broker ·|last synced|available sources/i)).toBeNull();
  });

  it("shows only linked Plaid for a Plaid portfolio", () => {
    state.unlocked = true;
    state.resource.mockReturnValue({ loading: false, data: {
      activeSource: "plaid", activeStatementSnapshotId: "selected",
      statementSnapshots: [{ id: "selected", fileName: "November statement.pdf" }],
      freshness: { lastSyncedAt: "2026-11-20T11:32:00.000Z" },
    } });
    render(<FinancePortfolioCard section="sources" />);
    const details = screen.getByText("Portfolio sources").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("Linked Plaid account")).toBeVisible();
    expect(screen.queryByText(/November statement|last synced/i)).toBeNull();
  });

  it("lets the person expand and collapse the holdings preview", () => {
    state.unlocked = true;
    state.resource.mockReturnValue({
      loading: false,
      data: {
        activeSource: "plaid",
        activePortfolio: {
          holdings: Array.from({ length: 6 }, (_, index) => ({
            symbol: `HOLD${index}`,
            name: `Sample holding ${index + 1}`,
            quantity: 1,
            price: 100,
            market_value: 100,
          })),
        },
      },
    });
    render(<FinancePortfolioCard section="holdings" />);
    const details = screen.getByText("Holdings").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    const list = screen.getByRole("list", { name: "Portfolio holdings" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 holdings" }));
    expect(within(list).getByText("Sample holding 6")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer holdings" }));
    expect(within(list).queryByText("Sample holding 6")).toBeNull();
  });

  it("uses logo images for public tickers and falls back when a logo is missing", () => {
    state.unlocked = true;
    const position = { quantity: 1, price: 100, market_value: 100 };
    state.resource.mockReturnValue({
      loading: false,
      data: {
        activeSource: "plaid",
        activePortfolio: {
          holdings: [
            { ...position, symbol: "AAPL", name: "Apple", identifier_type: "ticker" },
            { ...position, symbol: "LOCAL", name: "Internal identifier", identifier_type: "derived" },
            { ...position, symbol: "AAPL261120C00100000", name: "Option", identifier_type: "ticker" },
            { ...position, symbol: "CASH", name: "Cash", identifier_type: "ticker", is_cash_equivalent: true },
          ],
        },
      },
    });
    render(<FinancePortfolioCard section="holdings" />);
    const details = screen.getByText("Holdings").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    const list = screen.getByRole("list", { name: "Portfolio holdings" });
    const images = list.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", expect.stringMatching(/\/AAPL\.png$/));
    fireEvent.error(images[0]!);
    expect(list.querySelector("img")).toBeNull();
    expect(within(list).getByText("Apple")).toBeVisible();
  });
});
