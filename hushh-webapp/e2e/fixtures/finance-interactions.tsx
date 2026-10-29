import { FullscreenFlowShell } from "../../components/app-ui/fullscreen-flow-shell";
import { PortfolioImportView } from "../../components/kai/views/portfolio-import-view";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportProgressView } from "../../components/kai/views/import-progress-view";
import { DecisionCard } from "../../components/kai/views/decision-card";
import { HoldingRowActions } from "../../components/kai/holdings/holding-row-actions";
import { RiaPicksList } from "../../components/kai/cards/renaissance-market-list";
import { OneMarketNewsBriefing } from "../../components/kai/cards/market-news-briefing";
import { SectorRotationChart } from "../../components/kai/cards/sector-rotation-chart";
import { MarketIndexDetailSurface } from "../../components/kai/cards/market-index-detail";
import type { MarketOverviewMetric } from "../../components/kai/cards/market-overview-grid";
import { PortfolioValueCard } from "../../components/kai/cards/portfolio-value-card";
import financeStyles from "../../components/kai/shared/finance-workspace.module.css";
import { LineChart } from "../../components/icons";
import marketStyles from "../../components/kai/shared/market-briefing.module.css";

import { PortfolioReportAction } from "../../components/kai/cards/portfolio-report-action";
import { FinanceShareFlow } from "../../components/kai/sharing/finance-share-flow";
import { FinanceSharedDetail } from "../../components/kai/sharing/finance-shared-detail";
import { sharingModel } from "./finance-sharing-boundaries";
import { PortfolioOverview } from "../../components/kai/views/portfolio-overview";
import { PortfolioBriefing } from "../../components/kai/views/portfolio-briefing";
import { FinancePortfolioSharing } from "../../components/kai/sharing/finance-portfolio-sharing";
import { AnalysisHistoryList } from "../../components/kai/views/analysis-history-list";
import { VersionOptions } from "../../components/kai/views/analysis-history-version-options";
import { AnalysisSummaryView } from "../../components/kai/views/analysis-summary-view";
import { StockComparisonPreview } from "../../components/kai/cards/stock-comparison-preview";
import { PortfolioAllocationBar } from "../../components/kai/charts/portfolio-allocation-bar";
import { HoldingDetailsDrawer } from "../../components/kai/holdings/holding-details-drawer";
import { DataTable } from "../../components/app-ui/data-table";
import { holdingTableColumns } from "../../components/kai/holdings/holding-table-columns";
import { toHoldingViewModel } from "../../components/kai/holdings/holding-view-model";
import { mapPortfolioToDashboardViewModel } from "../../components/kai/views/dashboard-data-mapper";
import type { PortfolioData } from "../../components/kai/types/portfolio";
import type { HoldingsListItem } from "../../components/kai/holdings/holding-view-model";
import { groupHoldingPositions, prepareHoldingEntryEdit } from "../../lib/kai/holding-positions";
import { EditHoldingModal } from "../../components/kai/modals/edit-holding-modal";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import type { StockQuoteLoader } from "../../lib/services/public-stock-quote";

const samplePortfolio: PortfolioData = { account_summary: { beginning_value: 24000, ending_value: 24680.42, cash_balance: 2000 },
  holdings: [{ symbol: "TEST", name: "Sample Company", market_value: 22680.42, price: 226.8042, quantity: 100, cost_basis: 21000, sector: "Technology", source_type: "Statement", institution_price_as_of: "2026-10-20T20:00:00Z" }] };
const sampleModel = mapPortfolioToDashboardViewModel(samplePortfolio);
const savedEntry = { ticker: "TEST", timestamp: "2026-10-20T20:00:00Z", decision: "hold", confidence: .82, consensus_reached: false,
  agent_votes: { fundamental: "buy", sentiment: "hold", valuation: "reduce" }, final_statement: "Consider valuation alongside company strength and your portfolio exposure.",
  raw_card: { company_strength_score: 7, market_trend_score: 6, fair_value_score: 5, short_recommendation: "Consider valuation alongside company strength and your portfolio exposure." }, version: 3, companyName: "Sample Company With A Deliberately Long Name" };

const observedFixture = Array.from({ length: 31 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 8, 20 + index)).toISOString(),
  value: 440 + index / 2 + Math.sin(index) * 3,
}));

const loadSampleHistory = async () => ({ points: observedFixture, stale: false, cached: true, source: "Synthetic daily fixture", retrievedAt: "2026-10-20T20:00:00Z" });
const loadSampleQuote: StockQuoteLoader = async (symbol) => {
  document.body.dataset.quoteReads = String(Number(document.body.dataset.quoteReads || 0) + 1);
  if (document.body.dataset.quoteMode === "unavailable") return null;
  return { symbol, price: symbol === "BRK-B" ? 456.78 : 234.56, changePct: 1.2,
    quotedAt: "2026-10-20T20:00:00Z", source: "Synthetic quote fixture", stale: true, delayed: false };
};

function FinanceSharingFixture() {
  const [open, setOpen] = useState(false);
  const [received, setReceived] = useState(false);
  return <section className="mt-8">
    <p>Finance sharing · synthetic figures and connections</p>
    <button onClick={() => setOpen(true)}>Open sample Finance sharing</button>
    <button onClick={() => setReceived(true)}>Open sample received Finance</button>
    <FinanceShareFlow open={open} onOpenChange={setOpen} model={sharingModel} source={{ kind: "statement", snapshotId: null }} />
    <FinanceSharedDetail grantId={received ? "22222222-2222-4222-8222-222222222222" : null} onClose={() => setReceived(false)} />
  </section>;
}

function GroupedHoldingsFixture() {
  const [entries, setEntries] = useState<HoldingsListItem[]>([
    { client_id: "entry-one", entry_id: "entry-one", symbol: "TEST", name: "Sample Company", quantity: 10, price: 130, market_value: 1300, cost_basis: 1000, account_id: "sample", acquisition_date: "2026-01-10" },
    { client_id: "entry-two", entry_id: "entry-two", symbol: "TEST", name: "Sample Company", quantity: 5, price: 130, market_value: 650, cost_basis: 600, account_id: "sample", acquisition_date: "2026-05-10" },
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<HoldingsListItem | null>(null);
  const groups = groupHoldingPositions(entries);
  const total = groups.reduce((sum, row) => sum + row.market_value, 0);
  const position = groups.find(row => row.client_id === selected);
  return <section data-testid="grouped-holdings-fixture" className={`${financeStyles.workspace} mt-8`}>
    <h2>Grouped holdings · sample figures</h2>
    <div className="md:hidden"><SettingsGroup>{groups.map(row => <SettingsRow key={row.client_id}
      title={row.symbol} description={`${row.name} · ${row.entries.length} entries`} trailing={`$${row.market_value.toFixed(2)}`}
      ariaLabel={`View ${row.symbol} entries`} onClick={() => setSelected(row.client_id)} />)}</SettingsGroup></div>
    <div className="hidden md:block"><DataTable columns={holdingTableColumns(total, setSelected)} data={groups} onRowClick={row => setSelected(row.client_id)} /></div>
    <HoldingDetailsDrawer open={Boolean(position) && !editing} holding={position ? toHoldingViewModel(position, total) : null}
      entries={position?.entries.map(row => toHoldingViewModel(row, total))} canManageHoldings loadHistory={loadSampleHistory}
      onOpenChange={open => { if (!open) setSelected(null); }}
      onEditEntry={id => setEditing(entries.find(row => row.client_id === id)!)}
      onToggleDeleteEntry={id => setEntries(rows => rows.map(row => row.client_id === id ? { ...row, pending_delete: !row.pending_delete } : row))}
      onAddEntry={() => setEditing({ ...position!.entries[0]!, client_id: "entry-new", entry_id: "entry-new", quantity: 0, price: 0, market_value: 0, cost_basis: undefined, acquisition_date: undefined })} />
    <EditHoldingModal isOpen={Boolean(editing)} holding={editing} onClose={() => setEditing(null)} onSave={updated => {
      const next = prepareHoldingEntryEdit(updated, editing, entries) as HoldingsListItem;
      setEntries(rows => rows.some(row => row.client_id === next.client_id) ? rows.map(row => row.client_id === next.client_id ? next : row) : [...rows, next]);
      setEditing(null);
    }} />
  </section>;
}

function Fixture() {
  const [holdingOpen, setHoldingOpen] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [action, setAction] = useState("");
  const [indexMetric, setIndexMetric] = useState<MarketOverviewMetric | null>(null);
  return <main className="mx-auto max-w-3xl p-4">
    <section data-testid="finance-import-fixture"><FullscreenFlowShell width="agent"><PortfolioImportView onFileSelect={() => {}} onSkip={() => {}} /></FullscreenFlowShell></section>
    <section data-testid="finance-received-only-fixture" className="mt-4"><FinancePortfolioSharing /></section>
    <GroupedHoldingsFixture />
    <button onClick={() => setUpdated(true)}>Update progress</button>
    <ImportProgressView stage="extracting" isStreaming progressPct={updated ? 77 : undefined}
      statusMessage="Reading your statement"
      rawStreamLines={updated ? Array.from({ length: 15 }, (_, i) => `[THINKING] Processing holding ${i}`) : ["[THINKING] Reading statement"]} />
    <FinanceSharingFixture />
    <div data-testid="after-import">After import</div>
    <div data-testid="review-scroll" style={{ height: 220, overflow: "auto" }}>
      <HoldingRowActions symbol="TEST" layout="row" onEdit={() => setAction("Edit TEST")} onToggleDelete={() => setAction("Delete TEST")} />
      <div style={{ height: 800 }}>Other holdings</div>
    </div>
    <output data-testid="action-result">{action}</output>
    <DecisionCard result={{ ticker: "TEST", decision: "buy", confidence: 0.82,
      consensus_reached: false, final_statement: "Example verdict",
      agent_votes: { fundamental: "buy", technical: "hold", sentiment: "reduce" },
      dissenting_opinions: ["Example dissent"], raw_card: {} }} />
    <section data-testid="market-news-iphone-fixture" className="mt-8 [--one-link:var(--app-accent-deep)]">
      <OneMarketNewsBriefing rows={[0, 1, 2, 3].map((index) => ({ symbol: "TEST", title: `Market fixture story ${index}: a deliberately long company headline for a narrow phone`,
        url: `https://publisher.test/story-${index}`, published_at: "2026-10-20T20:00:00Z", source_name: "Publisher", provider: "fixture", degraded: false,
        image_url: "https://images.example.test/large.png", image_thumbnail_url: "https://images.example.test/small.png" }))} />
    </section>
    <section data-testid="portfolio-chart-fixture" className={`${financeStyles.workspace} mx-auto mt-8 w-full`}>
      <PortfolioValueCard source="Sample" value={24680.42} change={584.24} changePct={2.43} period="Sample portfolio · September 20 – October 20"
        history={observedFixture.map(point => ({ ...point, value: point.value * 54 }))} />
    </section>
    <section data-testid="portfolio-overview-fixture" className={`${financeStyles.workspace} mx-auto mt-8 w-full`}>
      <p className="mb-4 text-xs text-muted-foreground">Design verification · Sample figures only</p>
      <PortfolioOverview briefing={<PortfolioBriefing model={sampleModel} portfolio={samplePortfolio} onOpen={() => setAction("Open analysis")} />} model={sampleModel} portfolio={samplePortfolio} source="Sample" period="Sample statement · October 2026" onImport={() => setAction("Import portfolio")} onOpenSection={section => setAction(`Open ${section}`)} action={<PortfolioReportAction model={sampleModel} source="Sample" period="October 2026" onExport={() => setAction("Export report")} />} />
      <button className="mt-4 min-h-11" onClick={() => setHoldingOpen(true)}>Open sample holding</button>
      <HoldingDetailsDrawer loadHistory={loadSampleHistory} open={holdingOpen} onOpenChange={setHoldingOpen} holding={toHoldingViewModel({ ...samplePortfolio.holdings![0]!, client_id: "sample" }, 24680.42)} onEdit={() => setAction("Edit sample")} onToggleDelete={() => setAction("Delete sample")} />
    </section>
    <section data-testid="holdings-table-fixture" className="mx-auto mt-8 w-full">
      <DataTable columns={holdingTableColumns(24680.42)} data={samplePortfolio.holdings!.map((row, index) => ({ ...row, client_id: `sample-${index}` }))} tableClassName="w-full [&_th]:px-2 [&_td]:px-2 [&_td]:align-middle" />
    </section>
    <section data-testid="finance-history-fixture" className={`${financeStyles.workspace} mx-auto mt-8 w-full`}>
      <AnalysisHistoryList entries={[savedEntry]} onOpen={() => setAction("Open saved")} onVersions={() => setAction("Open versions")} onDelete={() => setAction("Delete saved")} onDeleteTicker={() => setAction("Delete ticker")} />
      <VersionOptions entries={[savedEntry]} onOpen={() => setAction("Open version 3")} onDelete={() => setAction("Delete version 3")} />
    </section>
    <section data-testid="finance-subpages-fixture" className={`${financeStyles.workspace} mx-auto mt-8 w-full space-y-5`}>
      <PortfolioAllocationBar data={sampleModel.allocation} totalValue={sampleModel.hero.totalValue} />
      <AnalysisSummaryView entry={savedEntry} embedded showHeader={false} />
      <StockComparisonPreview embeddedInDetailSurface preview={{ symbol: "TEST", quote: { company_name: "Sample Company", price: 226.8, change_pct: 1.2, sector: "Technology", as_of: "2026-10-20T20:00:00Z" },
        list_match: { in_list: true, tier: "KING", recommendation_bias: "Hold", sector: "Technology", fcf_billions: 4, investment_thesis: "Full investment thesis remains readable on a phone. Consider durable cash generation, competitive position, valuation assumptions and risks alongside the needs of your own portfolio." }, pick_sources: [], active_pick_source: "default" } as Parameters<typeof StockComparisonPreview>[0]["preview"]} onStartDebate={() => setAction("Start analysis")} />
    </section>
    <section data-testid="market-iphone-fixture" className={`${financeStyles.workspace} mx-auto mt-8 w-full`}>
      <RiaPicksList controlMode="adaptive-surface" loadQuote={loadSampleQuote} loadHistory={async () => ({ points: observedFixture, stale: true, retrievedAt: "2026-10-20T20:00:00Z" })} rows={[
        { symbol: "BRK-B", company_name: "Berkshire Hathaway Inc. Class B", sector: "Financials", tier: "KING", market_cap: 850_000_000_000,
          company_facts: { symbol: "BRK-B", summary: "This synthetic company profile describes several operating businesses. It serves customers through a range of subsidiaries. Additional details remain available in the complete profile for people who want to continue reading." },
          price: null, change_pct: null, volume: 1000, degraded: true, as_of: null, source_tags: ["layout fixture"] },
        { symbol: "AAPL", company_name: "Apple Inc", sector: "Technology", tier: "ACE", market_cap: 3_500_000_000_000,
          price: 234.56, change_pct: -0.4, volume: 1000, degraded: false, as_of: "2026-10-20T20:00:00Z", source_tags: ["layout fixture"] },
      ]} />
    </section>
    <section data-testid="sector-iphone-fixture" className={`app-page-shell ${marketStyles.typography} mt-8`}>
      <SectorRotationChart rows={Array.from({ length: 11 }, (_, index) => ({
        sector: index === 5 ? "Communication Services" : `Sector ${index}`,
        change_pct: index - 5, change_1w_pct: 5 - index,
        period_start_1d: "2026-10-19", period_start_1w: "2026-10-13", period_end: "2026-10-20",
        basis: "Sector ETF price return",
      }))} />
    </section>
    <section className="mt-8">
      {["S&P 500", "NASDAQ Composite", "Dow Jones", "Russell 2000"].map((label) => <button key={label} onClick={() => setIndexMetric({
        label, value: "7,712.57", delta: "+0.28%", tone: "positive", icon: LineChart, degraded: true,
        sparkline: [7695, 7702, 7698, 7708, 7705, 7712.57],
        detailPanel: { title: label, summary: "US equity index · points", value: "7,712.57", delta: "+0.28%", statusLabel: "Cached",
          facts: [{ label: "Source", value: "Yahoo Chart (Batch)" }, { label: "Quoted", value: "Oct 21, 2:15 AM" }],
          sections: [{ title: "About this quote", lines: ["Index levels and daily changes reflect the provider quote time above."] },
            { title: "Why it matters", lines: ["Use this benchmark to understand broad market conditions before reviewing advisor ideas or individual investments."] }],
        },
      })}>Open {label} detail</button>)}
      <MarketIndexDetailSurface metric={indexMetric} open={Boolean(indexMetric)} onOpenChange={(open) => { if (!open) setIndexMetric(null); }} />
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
