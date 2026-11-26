import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FinancePortfolioCard } from "@/components/agent/finance-portfolio-card";
import { A2uiSurfaceView } from "@/components/a2ui/a2ui-surface-view";
import { applyA2uiMessage, ONE_A2UI_CATALOG } from "@/lib/a2ui/surface-store";

const state = vi.hoisted(() => ({ unlocked: false, resource: vi.fn(), remember: vi.fn(async () => undefined) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: state.unlocked, vaultKey: "key", vaultOwnerToken: "token" }),
}));
vi.mock("@/lib/kai/kai-financial-resource", () => ({ KaiFinancialResourceService: { readForAnswer: state.resource } }));
vi.mock("@/lib/kai/portfolio-chat-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/kai/portfolio-chat-context")>(),
  rememberPortfolioCard: state.remember,
}));
vi.mock("@/components/kai/charts/portfolio-allocation-bar", () => ({ PortfolioAllocationBar: () => null }));
vi.mock("@/components/kai/charts/portfolio-history-chart", () => ({ PortfolioHistoryChart: () => null }));
vi.mock("@/components/kai/performance/performance-strip", () => ({ PerformanceStrip: () => null }));

function mockPortfolio(data: object) {
  state.resource.mockResolvedValue({
    isCurrent: () => true,
    resource: { statementSnapshots: [], ...data },
  });
}

function toggleCard(label: string, open = true) {
  const details = screen.getByText(label).closest("details")!;
  details.open = open;
  fireEvent(details, new Event("toggle"));
  return details;
}

describe("Finance portfolio card", () => {
  it("resolves the unlocked owner's active statement for a native card and expands all 52 positions", async () => {
    state.unlocked = true;
    state.resource.mockClear();
    mockPortfolio({
      activeSource: "statement",
      activeStatementSnapshotId: "active-statement",
      activePortfolio: {
        holdings: Array.from({ length: 52 }, (_, index) => ({
          symbol: `HOLD${index + 1}`, name: `Saved holding ${index + 1}`,
          quantity: 1, price: index + 1, market_value: index + 1, currency: "USD",
        })),
      },
    });
    const surface = applyA2uiMessage(new Map(), {
      version: "1.0",
      createSurface: {
        surfaceId: "saved", catalogId: ONE_A2UI_CATALOG,
        components: [{ id: "root", component: "SavedPortfolio", section: "holdings" }],
      },
    }).get("saved")!;
    const view = render(<A2uiSurfaceView surface={surface} />);
    expect(screen.getByText("Saved portfolio requested.")).toBeVisible();
    expect(state.resource).not.toHaveBeenCalled();
    view.rerender(<A2uiSurfaceView surface={surface} portfolioConversationId="owner-thread" />);
    await screen.findByText("Holdings");
    toggleCard("Holdings");
    const list = await screen.findByRole("list", { name: "Portfolio holdings" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 52 holdings" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(52);
    expect(within(list).getByText("Saved holding 1")).toBeVisible();
    expect(state.resource.mock.calls[0]?.[0]).toMatchObject({ userId: "owner" });
  });

  it("blocks protected information while locked", () => {
    state.unlocked = false;
    state.resource.mockClear();
    render(<FinancePortfolioCard section="holdings" />);
    toggleCard("Holdings");
    expect(screen.getByText("Sign in and unlock your vault to view your portfolio.")).toBeVisible();
    expect(state.resource).not.toHaveBeenCalled();
  });

  it("does not present inactive sources when no statement is selected", async () => {
    state.unlocked = true;
    mockPortfolio({
      activePortfolio: null, activeSource: "statement", activeStatementSnapshotId: null,
      statementSnapshots: [], availableSources: ["statement", "plaid"], freshness: null,
    });
    render(<FinancePortfolioCard section="sources" />);
    toggleCard("Portfolio sources");
    expect(await screen.findByText("No portfolio source available.")).toBeVisible();
    expect(screen.queryByText(/available sources|linked accounts/i)).toBeNull();
  });

  it("shows only the selected statement name and upload time", async () => {
    state.unlocked = true;
    const importedAt = "2026-11-20T11:32:00.000Z";
    mockPortfolio({
      activeSource: "statement", activeStatementSnapshotId: "selected",
      statementSnapshots: [
        { id: "newest", fileName: "Newer statement.pdf" },
        { id: "selected", fileName: "November statement.pdf", importedAt, label: "Broker · 2026-09-30" },
      ],
      availableSources: ["statement", "plaid"], freshness: { lastSyncedAt: importedAt },
    });
    render(<FinancePortfolioCard section="sources" />);
    const details = toggleCard("Portfolio sources");
    expect(await screen.findByText("November statement.pdf")).toBeVisible();
    expect(details.querySelector("time")).toHaveAttribute("datetime", importedAt);
    expect(screen.queryByText(/newer statement|broker ·|last synced|available sources/i)).toBeNull();
  });

  it("shows only linked Plaid for a Plaid portfolio", async () => {
    state.unlocked = true;
    mockPortfolio({
      activeSource: "plaid", activeStatementSnapshotId: "selected",
      statementSnapshots: [{ id: "selected", fileName: "November statement.pdf" }],
      freshness: { lastSyncedAt: "2026-11-20T11:32:00.000Z" },
    });
    render(<FinancePortfolioCard section="sources" />);
    toggleCard("Portfolio sources");
    expect(await screen.findByText("Linked Plaid account")).toBeVisible();
    expect(screen.queryByText(/November statement|last synced/i)).toBeNull();
  });

  it("previews the highest valued holdings before expanding the list", async () => {
    state.unlocked = true;
    mockPortfolio({
        activeSource: "plaid",
        activePortfolio: {
          holdings: Array.from({ length: 6 }, (_, index) => ({
            symbol: `HOLD${index}`,
            name: `Sample holding ${index + 1}`,
            quantity: 1,
            price: 100,
            market_value: index + 1,
            currency: "CAD",
          })),
        },
    });
    render(<FinancePortfolioCard section="holdings" />);
    toggleCard("Holdings");

    const list = await screen.findByRole("list", { name: "Portfolio holdings" });
    const preview = within(list).getAllByRole("listitem");
    expect(preview).toHaveLength(5);
    expect(preview[0]).toHaveTextContent("Sample holding 6");
    expect(preview[0]).toHaveTextContent("CA$6.00");
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 holdings" }));
    expect(within(list).getByText("Sample holding 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer holdings" }));
    expect(within(list).queryByText("Sample holding 1")).toBeNull();
  });

  it("uses logo images for public tickers and falls back when a logo is missing", async () => {
    state.unlocked = true;
    const position = { quantity: 1, price: 100, market_value: 100 };
    mockPortfolio({
        activeSource: "plaid",
        activePortfolio: {
          holdings: [
            { ...position, symbol: "AAPL", name: "Apple", identifier_type: "ticker" },
            { ...position, symbol: "LOCAL", name: "Internal identifier", identifier_type: "derived" },
            { ...position, symbol: "AAPL261120C00100000", name: "Option", identifier_type: "ticker" },
            { ...position, symbol: "CASH", name: "Cash", identifier_type: "ticker", is_cash_equivalent: true },
          ],
        },
    });
    render(<FinancePortfolioCard section="holdings" />);
    toggleCard("Holdings");

    const list = await screen.findByRole("list", { name: "Portfolio holdings" });
    const images = list.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", expect.stringMatching(/\/AAPL\.png$/));
    fireEvent.error(images[0]!);
    expect(list.querySelector("img")).toBeNull();
    expect(within(list).getByText("Apple")).toBeVisible();
  });

  it("binds follow-ups to the fresh snapshot drawn after a portfolio change", async () => {
    state.unlocked = true;
    state.remember.mockClear();
    const before = { userId: "owner", activeSource: "statement", activePortfolio: { holdings: [] } };
    const after = { ...before, activeSource: "plaid" };
    mockPortfolio(before);
    render(<FinancePortfolioCard section="holdings" conversationId="thread" />);
    toggleCard("Holdings");
    await waitFor(() => expect(state.remember).toHaveBeenLastCalledWith("thread", expect.objectContaining(before)));
    mockPortfolio(after);
    fireEvent(window, new CustomEvent("pkm-domain-changed", {
      detail: { userId: "owner", domain: "financial", operation: "stored" },
    }));
    await waitFor(() => expect(state.remember).toHaveBeenLastCalledWith("thread", expect.objectContaining(after)));
    expect(state.remember).toHaveBeenCalledTimes(2);
  });
});
