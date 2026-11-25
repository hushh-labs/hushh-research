"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { BriefcaseBusiness, ChevronDown } from "@/components/icons";
import { PortfolioAllocationBar } from "@/components/kai/charts/portfolio-allocation-bar";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import { PerformanceStrip } from "@/components/kai/performance/performance-strip";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { useAuth } from "@/hooks/use-auth";
import type { FinancePortfolioSection } from "@/lib/agent/finance-chat-experiences";
import { KaiFinancialResourceService, type KaiFinancialResource } from "@/lib/kai/kai-financial-resource";
import { normalizeMarketSymbol } from "@/lib/kai/market-symbol";
import { formatMoney } from "@/lib/kai/market-value-format";
import { activePortfolioChatView, rememberPortfolioCard } from "@/lib/kai/portfolio-chat-context";
import { Button } from "@/lib/morphy-ux/button";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

const titles: Record<FinancePortfolioSection, string> = {
  holdings: "Holdings", allocation: "Allocation", performance: "Performance", sources: "Portfolio sources",
};

const HOLDINGS_PREVIEW_COUNT = 5;
type PortfolioView = NonNullable<ReturnType<typeof activePortfolioChatView>>;

const savedMoney = (value: number, currency: string, compact = false) =>
  formatMoney(value, { region: "US", rate: null }, {
    source: currency, notation: compact ? "compact" : "standard",
  });

function HoldingsList({ positions, singleCurrency }: Pick<PortfolioView, "positions" | "singleCurrency">) {
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
        <span>{singleCurrency ? "Market value" : "Market value by currency"}</span>
      </div>
      <ul id={listId} aria-label="Portfolio holdings" className="divide-y divide-border/60">
        {visible.map(({ position: holding, facts }) => {
          const { name, currency, market_value: value } = facts;
          const symbol = holding.symbol !== name ? holding.symbol : null;
          const ticker = normalizeMarketSymbol(holding.symbol);
          const hasPublicTicker = holding.identifier_type === "ticker" ||
            (holding.identifier_type === undefined && holding.is_sec_common_equity_ticker === true);
          const useCompanyLogo = hasPublicTicker && !holding.is_cash_equivalent &&
            ticker !== "CASH" && /^[A-Z]{1,5}(?:[.-][A-Z])?$/.test(ticker);
          const unavailable = value === null;
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
                {unavailable ? "Unavailable" : currency ? savedMoney(value, currency) :
                  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} (currency unknown)`}
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

function PortfolioContent({ section, conversationId }: { section: FinancePortfolioSection; conversationId?: string | null }) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [sourceRevision, setSourceRevision] = useState(0);
  useEffect(() => subscribeToPkmDomainChanges(change => {
    if (change.userId === userId && change.domain === "financial") {
      setSourceRevision(revision => revision + 1);
    }
  }), [userId]);
  if (!userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
    return <p>Sign in and unlock your vault to view your portfolio.</p>;
  }
  return <OpenPortfolioSnapshot key={JSON.stringify([userId, conversationId, epoch, sourceRevision])}
    {...{ section, conversationId, userId, vaultKey, vaultOwnerToken, epoch }} />;
}

function OpenPortfolioSnapshot({ section, conversationId, userId, vaultKey, vaultOwnerToken, epoch }: {
  section: FinancePortfolioSection;
  conversationId?: string | null;
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  epoch: number;
}) {
  const [data, setData] = useState<KaiFinancialResource | null>();
  useEffect(() => {
    let mounted = true;
    const isCurrent = () => mounted && isVaultSessionEpochCurrent(epoch);
    void KaiFinancialResourceService.readForAnswer({ userId, vaultKey, vaultOwnerToken }, isCurrent)
      .then(read => {
        if (isCurrent()) setData(read?.isCurrent() ? read.resource : null);
      })
      .catch(() => {
        if (isCurrent()) setData(null);
      });
    return () => { mounted = false; };
  }, [userId, vaultKey, vaultOwnerToken, epoch]);
  useEffect(() => {
    if (!conversationId || section === "sources" || !data?.activePortfolio) return;
    void rememberPortfolioCard(conversationId, data).catch(() => {
      // A card can render when the device cannot capture a safe reference.
    });
  }, [conversationId, data, section]);
  if (data === undefined) return <p role="status">Loading portfolio…</p>;
  if (!data) return <p role="status">Portfolio information is unavailable.</p>;
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
  const view = activePortfolioChatView(data);
  if (!view) return <p>No portfolio is available yet.</p>;
  const { as_of: asOf, currency, performance, allocation, gain } = view;
  const source = data.activeSource === "plaid" ? "Linked accounts" : "Statement";
  const asOfLabel = asOf ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(asOf)) : null;
  const period = asOfLabel ? `${view.date_kind === "last_synced" ? "Last synced" : "Statement date"} ${asOfLabel}` : "Saved portfolio";
  const formatValue = (value: number) => currency ? savedMoney(value, currency) : "Unavailable";
  return (
    <div className="space-y-3">
      <p className="ui-text-row-description text-muted-foreground">{source} · {period}{currency ? ` · ${currency}` : ""}</p>
      {section === "holdings" ? (
        <HoldingsList positions={view.positions} singleCurrency={view.singleCurrency} />
      ) : null}
      {section === "allocation" ? (
        allocation?.length && performance.value !== null
          ? <SurfaceCard><PortfolioAllocationBar embedded data={allocation} totalValue={performance.value} formatValue={formatValue} /></SurfaceCard>
          : <p>Allocation is unavailable for this snapshot.</p>
      ) : null}
      {section === "performance" ? (
        <>
          {performance.value !== null || gain ? <PerformanceStrip value={performance.value} sinceBought={gain}
            invested={view.invested} cash={view.cash} period={period} formatValue={formatValue} />
            : <p>Performance summary is unavailable for this snapshot.</p>}
          {gain && performance.covered < performance.eligible ? (
            <p className="text-sm">Unrealized gain or loss covers {performance.covered} of {performance.eligible} positions.</p>
          ) : null}
          {performance.history_available && currency
            ? <SurfaceCard><SurfaceCardContent className="p-4"><PortfolioHistoryChart data={view.history} height={220}
              currency={currency} formatValue={(value, compact) => savedMoney(value, currency, compact)} /></SurfaceCardContent></SurfaceCard>
            : <p className="text-sm">History is unavailable for this snapshot.</p>}
        </>
      ) : null}
    </div>
  );
}

export function FinancePortfolioCard({ section, conversationId }: { section: FinancePortfolioSection; conversationId?: string | null }) {
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
            <PortfolioContent section={section} conversationId={conversationId} />
          </SurfaceCardContent>
        ) : null}
      </details>
    </SurfaceCard>
  );
}
