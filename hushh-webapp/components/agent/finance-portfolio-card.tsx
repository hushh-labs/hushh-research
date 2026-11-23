"use client";

import { useId, useState } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { BriefcaseBusiness, ChevronDown } from "@/components/icons";
import { PortfolioAllocationBar } from "@/components/kai/charts/portfolio-allocation-bar";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import { PerformanceStrip } from "@/components/kai/performance/performance-strip";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { overviewFacts } from "@/components/kai/views/portfolio-display-facts";
import { useAuth } from "@/hooks/use-auth";
import type { FinancePortfolioSection } from "@/lib/agent/finance-chat-experiences";
import { useKaiFinancialResource } from "@/lib/kai/kai-financial-resource";
import { groupHoldingPositions, type HoldingPosition } from "@/lib/kai/holding-positions";
import { normalizeMarketSymbol } from "@/lib/kai/market-symbol";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { sinceBought } from "@/lib/kai/portfolio-performance";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

const titles: Record<FinancePortfolioSection, string> = {
  holdings: "Holdings", allocation: "Allocation", performance: "Performance", sources: "Portfolio sources",
};

const HOLDINGS_PREVIEW_COUNT = 5;

function HoldingsList({ positions }: { positions: HoldingPosition[] }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  if (positions.length === 0) return <p className="ui-text-row-description">No holdings in this snapshot.</p>;

  const hasMore = positions.length > HOLDINGS_PREVIEW_COUNT;
  const visible = showAll ? positions : positions.slice(0, HOLDINGS_PREVIEW_COUNT);
  const countLabel = visible.length < positions.length
    ? `${visible.length} of ${positions.length} holdings`
    : positions.length === 1 ? "1 holding" : `${positions.length} holdings`;

  return (
    <div>
      <div className="flex justify-between gap-2 border-b border-border/60 pb-2 ui-text-row-description text-muted-foreground">
        <span>{countLabel}</span>
        <span>Market value</span>
      </div>
      <ul id={listId} aria-label="Portfolio holdings" className="divide-y divide-border/60">
        {visible.map(holding => {
          const name = holding.name || holding.symbol;
          const symbol = holding.symbol !== name ? holding.symbol : null;
          const ticker = normalizeMarketSymbol(holding.symbol);
          const hasPublicTicker = holding.identifier_type === "ticker" ||
            (holding.identifier_type === undefined && holding.is_sec_common_equity_ticker === true);
          const useCompanyLogo = hasPublicTicker && !holding.is_cash_equivalent &&
            ticker !== "CASH" && /^[A-Z]{1,5}(?:[.-][A-Z])?$/.test(ticker);
          const unavailable = holding.entries.some(entry => entry.market_value_unavailable);
          return (
            <li key={holding.client_id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5 sm:gap-3">
              <SymbolAvatar
                symbol={ticker}
                name={name}
                isCash={holding.is_cash_equivalent}
                logo={useCompanyLogo}
                className="size-8 rounded-xl"
              />
              <div className="min-w-0">
                <p title={name} className="line-clamp-2 break-words ui-text-row-label-emphasized text-foreground">{name}</p>
                {symbol ? <p title={symbol} className="truncate ui-text-row-description text-muted-foreground">{symbol}</p> : null}
              </div>
              <span className={cn(
                "whitespace-nowrap text-right tabular-nums",
                unavailable ? "ui-text-row-description text-muted-foreground" : "ui-text-row-label-emphasized text-foreground",
              )}>
                {unavailable ? "Unavailable" : formatCurrency(holding.market_value, holding.currency || holding.iso_currency_code)}
              </span>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <div className="border-t border-border/60 pt-2">
          <Button type="button" variant="plain" size="standard" className="w-full"
            aria-controls={listId} aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>
            {showAll ? "Show fewer holdings" : `Show all ${positions.length} holdings`}
            <ChevronDown aria-hidden="true" className={cn("size-4", showAll && "rotate-180")} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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
    if (data.activeSource === "plaid") return <p>Linked Plaid account</p>;
    const statement = data.statementSnapshots.find(item => item.id === data.activeStatementSnapshotId);
    if (!statement) return <p>No portfolio source available.</p>;
    const importedAt = statement.importedAt;
    const uploadedAt = importedAt && Number.isFinite(Date.parse(importedAt))
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          ...(/T\d{2}:\d{2}/i.test(importedAt) ? { timeStyle: "short" } : { timeZone: "UTC" }),
        }).format(new Date(importedAt))
      : null;
    return (
      <div className="space-y-1">
        <p className="break-words ui-text-row-label-emphasized">{statement.fileName || "Statement name unavailable"}</p>
        {uploadedAt && importedAt ? (
          <p className="ui-text-row-description text-muted-foreground">
            Imported <time dateTime={importedAt}>{uploadedAt}</time>
          </p>
        ) : null}
      </div>
    );
  }
  if (!data.activePortfolio) return <p>No portfolio is available yet.</p>;

  const portfolio = data.activePortfolio;
  const model = mapPortfolioToDashboardViewModel(portfolio);
  const period = model.hero.statementPeriod || "Current portfolio snapshot";
  const source = data.activeSource === "plaid" ? "Linked accounts" : "Statement";
  const performance = sinceBought(model.canonicalModel.positions);
  return (
    <div className="space-y-3">
      <p className="ui-text-row-description text-muted-foreground">{source} · {period}</p>
      {section === "holdings" ? (
        <HoldingsList positions={groupHoldingPositions(portfolio.holdings || []).filter(position => !position.pending_delete)} />
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
    <SurfaceCard>
      <details className="group" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-[inherit] px-[var(--surface-card-content-px)] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {section === "holdings" ? (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BriefcaseBusiness aria-hidden="true" className="size-4" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 ui-text-section-label text-foreground">{titles[section]}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
        </summary>
        {open ? (
          <SurfaceCardContent>
            <PortfolioContent section={section} />
          </SurfaceCardContent>
        ) : null}
      </details>
    </SurfaceCard>
  );
}
