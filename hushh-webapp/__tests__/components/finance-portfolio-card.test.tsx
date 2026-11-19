import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows available sources even without an active portfolio", () => {
    state.unlocked = true;
    state.resource.mockReturnValue({ loading: false, data: {
      activePortfolio: null, activeSource: "statement", activeStatementSnapshotId: null,
      statementSnapshots: [], availableSources: ["statement", "plaid"], freshness: null,
    } });
    render(<FinancePortfolioCard section="sources" />);
    const details = screen.getByText("Portfolio sources").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("Available sources: Statement, Linked accounts")).toBeVisible();
  });
});
