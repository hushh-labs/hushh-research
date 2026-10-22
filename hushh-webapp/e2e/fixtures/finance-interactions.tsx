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
import { LineChart } from "../../components/icons";
import marketStyles from "../../components/kai/shared/market-briefing.module.css";

function Fixture() {
  const [updated, setUpdated] = useState(false);
  const [action, setAction] = useState("");
  const [indexMetric, setIndexMetric] = useState<MarketOverviewMetric | null>(null);
  return <main className="mx-auto max-w-3xl p-4">
    <button onClick={() => setUpdated(true)}>Update progress</button>
    <ImportProgressView stage="extracting" isStreaming progressPct={updated ? 77 : undefined}
      statusMessage="Reading your statement"
      rawStreamLines={updated ? Array.from({ length: 15 }, (_, i) => `[THINKING] Processing holding ${i}`) : ["[THINKING] Reading statement"]} />
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
    <section data-testid="market-iphone-fixture" className="mt-8">
      <RiaPicksList controlMode="adaptive-surface" rows={[
        { symbol: "BRK-B", company_name: "Berkshire Hathaway Inc. Class B", sector: "Financials", tier: "KING", market_cap: 850_000_000_000,
          price: 456.78, change_pct: 1.2, volume: 1000, degraded: false, as_of: "2026-10-20T20:00:00Z", source_tags: ["layout fixture"] },
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
