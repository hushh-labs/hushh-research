"use client";

import { useState } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioAllocationBar } from "@/components/kai/charts/portfolio-allocation-bar";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import { PerformanceStrip } from "@/components/kai/performance/performance-strip";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { overviewFacts } from "@/components/kai/views/portfolio-display-facts";
import { useAuth } from "@/hooks/use-auth";
import type { FinancePortfolioSection } from "@/lib/agent/agui-structured-experiences";
import { useKaiFinancialResource } from "@/lib/kai/kai-financial-resource";
import { groupHoldingPositions } from "@/lib/kai/holding-positions";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { sinceBought } from "@/lib/kai/portfolio-performance";
import { useVault } from "@/lib/vault/vault-context";

const titles: Record<FinancePortfolioSection, string> = {
  holdings: "Holdings", allocation: "Allocation", performance: "Performance", sources: "Portfolio sources",
};

function PortfolioContent({ section }: { section: FinancePortfolioSection }) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const enabled = Boolean(userId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const { data, loading, error } = useKaiFinancialResource({
    userId: userId || "", vaultKey, vaultOwnerToken, enabled, backgroundRefresh: false,
  });
  if (!enabled) return <p>Sign in and unlock your vault to view your portfolio.</p>;
  if (loading && !data) return <p role="status">Loading portfolio…</p>;
  if (error && !data) return <p role="status">Portfolio information is unavailable.</p>;
  if (!data) return <p>No portfolio is available yet.</p>;
  if (section === "sources") {
    const statement = data.statementSnapshots.find(item => item.id === data.activeStatementSnapshotId);
    return <div className="space-y-1 text-sm">
      <p>Active source: {data.activeSource === "plaid" ? "Linked accounts" : "Statement"}</p>
      {data.activeSource === "statement" && statement ? <p>{statement.label}</p> : null}
      <p>Available sources: {data.availableSources.map(item => item === "plaid" ? "Linked accounts" : "Statement").join(", ") || "None"}</p>
      {data.freshness?.lastSyncedAt ? <p>Last synced {new Date(data.freshness.lastSyncedAt).toLocaleString()}</p> : null}
    </div>;
  }
  if (!data.activePortfolio) return <p>No portfolio is available yet.</p>;

  const portfolio = data.activePortfolio;
  const model = mapPortfolioToDashboardViewModel(portfolio);
  const period = model.hero.statementPeriod || "Current portfolio snapshot";
  const source = data.activeSource === "plaid" ? "Linked accounts" : "Statement";
  const performance = sinceBought(model.canonicalModel.positions);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{source} · {period}</p>
      {section === "holdings" ? (
        <ul className="divide-y divide-border">
          {groupHoldingPositions(portfolio.holdings || []).filter(position => !position.pending_delete).map(holding => (
            <li key={holding.client_id} className="flex justify-between gap-3 py-2 text-sm">
              <span>{holding.name || holding.symbol}{holding.symbol && holding.name ? ` · ${holding.symbol}` : ""}</span>
              <span>{holding.entries.some(entry => entry.market_value_unavailable)
                ? "Unavailable"
                : formatCurrency(holding.market_value, holding.currency || holding.iso_currency_code)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {section === "allocation" ? (
        model.quality.allocationReady
          ? <SurfaceCard><PortfolioAllocationBar embedded data={model.allocation} totalValue={model.hero.totalValue} /></SurfaceCard>
          : <p>Allocation is unavailable for this snapshot.</p>
      ) : null}
      {section === "performance" ? (
        <>
          <PerformanceStrip value={model.hero.totalValue} sinceBought={performance}
            invested={overviewFacts(model, portfolio).invested} cash={overviewFacts(model, portfolio).cash} period={period} />
          {performance && performance.covered < performance.eligible ? (
            <p className="text-sm">Unrealized gain or loss covers {performance.covered} of {performance.eligible} positions.</p>
          ) : null}
          {model.quality.historyReady && model.history.length >= 2
            ? <SurfaceCard><SurfaceCardContent className="p-4"><PortfolioHistoryChart data={model.history} height={220} /></SurfaceCardContent></SurfaceCard>
            : <p className="text-sm">History is unavailable for this snapshot.</p>}
        </>
      ) : null}
    </div>
  );
}

export function FinancePortfolioCard({ section }: { section: FinancePortfolioSection }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded-xl border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">{titles[section]}</summary>
      {open ? <div className="mt-3"><PortfolioContent section={section} /></div> : null}
    </details>
  );
}
