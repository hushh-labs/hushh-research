import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PortfolioReviewView } from "@/components/kai/views/portfolio-review-view";
import { DashboardMasterView } from "@/components/kai/views/dashboard-master-view";
import type { PortfolioData } from "@/components/kai/types/portfolio";

const saved = vi.hoisted(() => ({ domain: null as Record<string, unknown> | null, current: {} as Record<string, unknown>, cache: vi.fn(), reload: vi.fn() }));
vi.mock("@/lib/kai/brokerage/use-portfolio-sources", () => ({ usePortfolioSources: ({ initialStatementPortfolio }: { initialStatementPortfolio: PortfolioData }) => ({
  isLoading: false, statementPortfolio: initialStatementPortfolio, activePortfolio: initialStatementPortfolio,
  activeSource: "statement", availableSources: ["statement"], statementSnapshots: [], activeStatementSnapshotId: null,
  reload: saved.reload,
}) }));
vi.mock("@/lib/kai/ticker-universe-cache", () => ({ getTickerUniverseSnapshot: () => [], preloadTickerUniverse: async () => [], searchTickerUniverse: () => [], searchTickerUniverseRemote: async () => [] }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "synthetic-memory-key", vaultOwnerToken: "synthetic-token", getVaultKey: () => "synthetic-memory-key", getVaultOwnerToken: () => "synthetic-token" }) }));
vi.mock("@/lib/cache/cache-context", () => ({ useCache: () => ({ setPortfolioData: saved.cache }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/one/kai/import", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: { checkVault: async () => true } }));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: { prepareDomainWriteContext: async () => ({ domainData: {} }) } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: {
  saveMergedDomain: async ({ build }: { build: (context: { currentDomainData: Record<string, unknown> }) => { domainData: Record<string, unknown> } }) => {
    saved.domain = build({ currentDomainData: saved.current }).domainData;
    return { success: true };
  },
} }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onPortfolioUpserted: vi.fn() } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: {} }));
vi.mock("@/lib/services/app-background-task-service", () => ({ AppBackgroundTaskService: {
  startTask: () => "synthetic-save", completeTask: vi.fn(), failTask: vi.fn(),
} }));

it("retains supplied balance observations in the confirmed stored portfolio and selected snapshot", async () => {
  const history = [{ date: "2026-07-01", value: 0 }, { date: "2026-07-31", value: 120 }];
  render(<PortfolioReviewView userId="synthetic-owner" onSaveComplete={vi.fn()} onReimport={vi.fn()}
    portfolioData={{ historical_values: history, total_value: 120, account_summary: { ending_value: 120 },
      account_info: { brokerage: "Example", statement_period_end: "2026-07-31" },
      holdings: [{ symbol: "TEST", name: "Example holding", quantity: 1, price: 120, market_value: 120 }] }} />);
  fireEvent.click(screen.getByRole("button", { name: /Save.*Vault/i }));
  await waitFor(() => expect(saved.domain).not.toBeNull());
  expect(saved.domain?.portfolio).toMatchObject({ historical_values: history });
  const sources = saved.domain?.sources as { statement: { snapshots: Array<{ canonical_v2: unknown }> } };
  expect(sources.statement.snapshots[0]?.canonical_v2).toMatchObject({ historical_values: history });
  await waitFor(() => expect(saved.cache.mock.calls.at(-1)?.[1]).toMatchObject({ historical_values: history }));
});

it("opens the actual invalid entry on portfolio confirmation instead of a generic save error", async () => {
  saved.domain = null;
  render(<PortfolioReviewView userId="synthetic-owner" onSaveComplete={vi.fn()} onReimport={vi.fn()}
    portfolioData={{ total_value: 8245, account_summary: { ending_value: 8245 }, holdings: [
      { symbol: "CASH", name: "Sweep", quantity: 0, price: 0, market_value: 8245, is_cash_equivalent: true },
      { symbol: "GOOG", name: "Alphabet", quantity: 10, price: 0, market_value: 0 },
    ] }} />);
  fireEvent.click(screen.getByRole("button", { name: /Save.*Vault/i }));
  await waitFor(() => expect(screen.getByLabelText(/^Price/)).toHaveFocus());
  expect(screen.getByLabelText(/^Symbol/)).toHaveValue("GOOG");
  expect(screen.getByLabelText(/^Quantity/)).toHaveValue(10);
  expect(screen.getByLabelText(/^Price/)).toHaveAccessibleDescription("Enter a price above $0.");
  expect(saved.domain).toBeNull();
  fireEvent.change(screen.getByLabelText(/^Price/), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /Save.*Vault/i, hidden: true }));
  await waitFor(() => expect(saved.domain?.portfolio).toMatchObject({ total_value: 9245, cash_balance: 8245,
    account_summary: { ending_value: 9245, cash_balance: 8245 } }));
});

it.each([8245, 0])("targets filtered invalid entries and keeps the new stock draft with a %s cash balance", async (initialCash) => {
  const portfolio: PortfolioData = { total_value: 8245, account_summary: { ending_value: 8245, cash_balance: 8245 },
    holdings: [{ symbol: "CASH", name: "Sweep", quantity: 0, price: 0, market_value: initialCash },
      { symbol: "AAPL", name: "Apple", quantity: 10, price: 0, market_value: 0 }] };
  saved.domain = null;
  saved.current = { portfolio };
  render(<DashboardMasterView userId="synthetic-owner" vaultOwnerToken="synthetic-token" portfolioData={portfolio} onReupload={vi.fn()} section="holdings" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  fireEvent.change(screen.getByLabelText(/^Symbol/), { target: { value: "GOOG" } });
  fireEvent.change(screen.getByLabelText(/^Company Name/), { target: { value: "Alphabet" } });
  fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText(/^Price/), { target: { value: "1600" } });
  expect(screen.getByLabelText(/^Symbol/)).toHaveValue("GOOG");
  expect(screen.getByLabelText(/^Quantity/)).toHaveValue(10);
  expect(screen.getByLabelText(/^Price/)).toHaveValue(1600);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add", exact: true }));
  // JSDOM retains the closed drawer during its CSS exit; browser checks prove removal.
  expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
  fireEvent.change(screen.getByLabelText("Search holdings"), { target: { value: "GOOG" } });
  expect(within(screen.getByTestId("portfolio-holdings-mobile-list")).queryByText("AAPL")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save holdings changes", exact: true, hidden: true }));
  if (initialCash === 0) {
    await waitFor(() => expect(screen.getByLabelText("Cash balance")).toHaveFocus());
    expect(saved.domain).toBeNull();
    fireEvent.change(screen.getByLabelText("Cash balance"), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save holdings changes", exact: true, hidden: true }));
  }
  await waitFor(() => expect(screen.getByLabelText(/^Price/)).toHaveFocus());
  expect(screen.getByLabelText(/^Symbol/)).toHaveValue("AAPL");
  expect(screen.getByLabelText(/^Quantity/)).toHaveValue(10);
  expect(saved.domain).toBeNull();
  fireEvent.change(screen.getByLabelText(/^Price/), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes", exact: true }));
  expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
  fireEvent.click(screen.getByRole("button", { name: "Save holdings changes", exact: true, hidden: true }));
  const cash = initialCash || 8000;
  await waitFor(() => expect(saved.domain?.portfolio).toMatchObject({ total_value: 17000 + cash,
    cash_balance: cash, account_summary: { ending_value: 17000 + cash, cash_balance: cash, equities_value: 17000 },
    holdings: expect.arrayContaining([
      expect.objectContaining({ symbol: "CASH", quantity: 0, price: 0, market_value: cash }),
      expect.objectContaining({ symbol: "GOOG", quantity: 10, price: 1600, market_value: 16000 }),
      expect.objectContaining({ symbol: "AAPL", quantity: 10, price: 100, market_value: 1000 }),
    ]) }));
});
