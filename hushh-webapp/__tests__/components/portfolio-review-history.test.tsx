import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { buildStatementImportWrite } from "@/lib/kai/brokerage/statement-import-write";
import { PortfolioReviewView } from "@/components/kai/views/portfolio-review-view";
import { DashboardMasterView } from "@/components/kai/views/dashboard-master-view";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { ApiService } from "@/lib/services/api-service";

const saved = vi.hoisted(() => ({ domain: null as Record<string, unknown> | null, current: {} as Record<string, unknown>, retryCurrent: null as Record<string, unknown> | null, cache: vi.fn(), reload: vi.fn() }));
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
    if (saved.retryCurrent) saved.domain = build({ currentDomainData: saved.retryCurrent }).domainData;
    return { success: true, fullBlob: { financial: saved.domain } };
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

it("rebases a confirmed import on the winning financial revision and retains its encrypted result", async () => {
  saved.domain = null;
  saved.current = { profile: { goal: "old" } };
  saved.retryCurrent = { profile: { goal: "current" }, analysis: { decisions: ["keep"] },
    documents: { preserved: "private" }, sources: { statement: { snapshots: [{ id: "other", imported_at: "2026-06-01" }] } } };
  try {
    const complete = vi.fn();
    render(<PortfolioReviewView userId="synthetic-owner" importFileName="October statement.pdf" onSaveComplete={complete} onReimport={vi.fn()}
      portfolioData={{ account_info: { brokerage: "Example", account_number: "test-account", statement_period_end: "2026-10-31" },
        holdings: [{ symbol: "TEST", name: "Example holding", quantity: 1, price: 120, market_value: 120 }] }} />);
    fireEvent.click(screen.getByRole("button", { name: /Save.*Vault/i }));
    await waitFor(() => expect(complete).toHaveBeenCalled());
    expect(saved.domain).toMatchObject({ profile: { goal: "current" }, analysis: { decisions: ["keep"] },
      documents: { preserved: "private", statements: expect.arrayContaining([expect.objectContaining({ id: "other" }),
        expect.objectContaining({ source: expect.objectContaining({ filename: "October statement.pdf" }),
          import_result: expect.objectContaining({ state: "saved", holdings_saved: 1, added: null, updated: null, unchanged: null, failed: 0 }) })]) } });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ source_metadata: { active_snapshot_id: expect.stringMatching(/^stmt_/) } });
  } finally { saved.retryCurrent = null; saved.current = {}; }
});

it("retains an unchanged import receipt and refuses ambiguous baselines or newer storage", () => {
  const portfolio = { holdings: [{ symbol: "TEST", name: "Example", quantity: 1, price: 120, market_value: 120, identifier_type: "ticker" as const }],
    source_metadata: { source_type: "statement", source_id: "statement-one", active_snapshot_id: "statement-one" } };
  const canonical = { ...portfolio, domain_intent: { source: "kai_import_llm", updated_at: "2026-10-01" } };
  const snapshot = { id: "statement-one", imported_at: "2026-10-01", canonical_v2: canonical };
  const input = { snapshot, portfolio, analytics: null, summary: {}, now: "2026-10-01", skipped: 0 };
  const first = buildStatementImportWrite({ ...input, current: {} });
  expect(first.domainData.documents.statements[0]?.import_result).toMatchObject({ added: 1, failed: 0, holdings_saved: 1 });
  const replay = buildStatementImportWrite({ ...input, current: first.domainData,
    now: "2026-10-02", snapshot: { ...snapshot, imported_at: "2026-10-02", canonical_v2: { ...canonical,
      domain_intent: { source: "kai_import_llm", updated_at: "2026-10-02" } } } });
  expect(replay.domainData.documents.statements[0]?.import_result).toEqual(first.domainData.documents.statements[0]?.import_result);
  expect(replay.domainData.documents.statements[0]?.imported_at).toBe("2026-10-01");
  for (const current of [
    { portfolio: { holdings: [{ name: "Unknown security", quantity: 1 }], source_metadata: portfolio.source_metadata } },
    { portfolio, sources: { active_source: "plaid" } },
    { portfolio: { ...portfolio, source_metadata: { source_id: "different-source" } } },
  ]) {
    expect(buildStatementImportWrite({ ...input, current }).domainData.documents.statements[0]?.import_result)
      .toMatchObject({ counts_available: false, added: null, updated: null });
  }
  expect(() => buildStatementImportWrite({ ...input, current: { pkm_contract_version: "7.0.0", financial_core_v7: {} } }))
    .toThrow("Update One");
});

it("opens the actual invalid entry on portfolio confirmation instead of a generic save error", async () => {
  saved.domain = null;
  const complete = vi.fn();
  render(<PortfolioReviewView userId="synthetic-owner" onSaveComplete={complete} onReimport={vi.fn()}
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
  await waitFor(() => expect(complete).toHaveBeenCalledWith(expect.objectContaining({ total_value: 9245,
    cash_balance: 8245, source_metadata: expect.objectContaining({ active_snapshot_id: expect.stringMatching(/^stmt_/) }) })));
  expect(saved.cache.mock.calls.at(-1)?.[1]).toMatchObject({ total_value: 9245, cash_balance: 8245 });
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

it.each(["mobile", "desktop"])("opens Manage entries directly from the %s holdings list", (layout) => {
  const history = vi.spyOn(ApiService, "getKaiStockPriceHistory")
    .mockResolvedValue({ points: [], stale: false, retrievedAt: null });
  try {
    const portfolio: PortfolioData = { total_value: 242, account_summary: { ending_value: 242 }, holdings: [
      { symbol: "AAA", name: "Example Alloy", quantity: 11, price: 11, market_value: 121, acquisition_date: "2026-11-04" },
      { symbol: "AAA", name: "Example Alloy", quantity: 11, price: 11, market_value: 121, acquisition_date: "2026-11-09" },
    ] };
    render(<DashboardMasterView userId="synthetic-owner" vaultOwnerToken="synthetic-token" portfolioData={portfolio} onReupload={vi.fn()} section="holdings" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const list = within(layout === "mobile" ? screen.getByTestId("portfolio-holdings-mobile-list") : screen.getByRole("table"));
    fireEvent.click(list.getByRole("button", { name: "Manage entries for AAA" }));
    const sheet = screen.getByRole("dialog", { name: "Manage entries" });
    expect(sheet).toHaveAttribute("data-state", "open");
    expect(within(sheet).getByText("22 shares across 2 entries")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "AAA" })).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "AAA" })).toBeNull();
    fireEvent.click(list.getByText("AAA", { exact: true }));
    expect(screen.getByRole("dialog", { name: "AAA" })).toHaveAttribute("data-state", "open");
  } finally {
    history.mockRestore();
  }
});

it("manages the lots of one position from a Manage entries sheet and keeps each acquisition date", async () => {
  saved.domain = null;
  render(<PortfolioReviewView userId="synthetic-owner" onSaveComplete={vi.fn()} onReimport={vi.fn()}
    portfolioData={{ total_value: 242, account_summary: { ending_value: 242 }, holdings: [
      { symbol: "AAA", name: "Example Alloy", quantity: 11, price: 11, market_value: 121, acquisition_date: "2026-11-04" },
      { symbol: "AAA", name: "Example Alloy", quantity: 11, price: 11, market_value: 121, acquisition_date: "2026-11-09" },
    ] }} />);
  expect(screen.queryByRole("button", { name: /^2 entries/ })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Manage entries for AAA" })[0]!);
  const sheet = screen.getByRole("dialog");
  expect(within(sheet).getByText("22 shares across 2 entries")).toBeVisible();
  expect(within(sheet).getByText("Acquired 2026-11-04")).toBeVisible();
  expect(within(sheet).getByText("Acquired 2026-11-09")).toBeVisible();
  fireEvent.click(within(sheet).getByRole("button", { name: "Remove entry 1" }));
  expect(within(sheet).getByText(/Entry 1 · Pending removal/)).toBeVisible();
  expect(within(sheet).getByText("Acquired 2026-11-09")).toBeVisible();
  expect(saved.domain).toBeNull();
});
