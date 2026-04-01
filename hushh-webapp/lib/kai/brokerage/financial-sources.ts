"use client";

import type { PortfolioData } from "@/components/kai/types/portfolio";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";

import type {
  PlaidPortfolioStatusResponse,
  PortfolioSource,
  StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";

type AnyObj = Record<string, unknown>;

function asRecord(value: unknown): AnyObj | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyObj)
    : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function getSources(financial: AnyObj | null | undefined): AnyObj {
  return asRecord(financial?.sources) ?? {};
}

function getStatementSource(financial: AnyObj | null | undefined): AnyObj {
  return asRecord(getSources(financial).statement) ?? {};
}

function getPlaidSource(financial: AnyObj | null | undefined): AnyObj {
  return asRecord(getSources(financial).plaid) ?? {};
}

function getPortfolioAnalytics(portfolio: AnyObj | null | undefined): AnyObj | null {
  return asRecord(portfolio?.analytics_v2) ?? null;
}

function hasHoldings(portfolio: unknown): portfolio is PortfolioData {
  const holdingsLength = Array.isArray((portfolio as PortfolioData | null | undefined)?.holdings)
    ? (portfolio as PortfolioData).holdings?.length ?? 0
    : 0;
  return Boolean(
    portfolio &&
      typeof portfolio === "object" &&
      !Array.isArray(portfolio) &&
      holdingsLength > 0
  );
}

function formatStatementSnapshotLabel(snapshot: AnyObj): string {
  const source = asRecord(snapshot.source);
  const brokerage = cleanText(source?.brokerage) ?? "Statement";
  const statementPeriodEnd = cleanText(source?.statement_period_end);
  if (statementPeriodEnd) {
    return `${brokerage} · ${statementPeriodEnd}`;
  }
  const importedAt = cleanText(snapshot.imported_at);
  if (importedAt) {
    const parsed = new Date(importedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return `${brokerage} · ${parsed.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`;
    }
  }
  return brokerage;
}

export function getStatementSnapshots(financial: AnyObj | null | undefined): AnyObj[] {
  const statementSnapshots = asArray<AnyObj>(getStatementSource(financial).snapshots);
  if (statementSnapshots.length > 0) {
    return statementSnapshots.filter((snapshot) => cleanText(snapshot.id));
  }

  const documents = asRecord(financial?.documents);
  const legacySnapshots = asArray<AnyObj>(documents?.statements);
  return legacySnapshots.filter((snapshot) => cleanText(snapshot.id));
}

export function getStatementSnapshotOptions(
  financial: AnyObj | null | undefined
): StatementSnapshotOption[] {
  return getStatementSnapshots(financial).map((snapshot) => {
    const source = asRecord(snapshot.source);
    return {
      id: String(snapshot.id),
      label: formatStatementSnapshotLabel(snapshot),
      brokerage: cleanText(source?.brokerage),
      statementPeriodEnd: cleanText(source?.statement_period_end),
      importedAt: cleanText(snapshot.imported_at),
    };
  });
}

export function getActiveSource(
  financial: AnyObj | null | undefined
): PortfolioSource {
  const activeSource = cleanText(getSources(financial).active_source);
  return activeSource === "plaid" ? "plaid" : "statement";
}

export function getActiveStatementSnapshotId(
  financial: AnyObj | null | undefined
): string | null {
  const activeSnapshotId = cleanText(getStatementSource(financial).active_snapshot_id);
  if (activeSnapshotId) return activeSnapshotId;
  const firstSnapshot = getStatementSnapshots(financial)[0];
  return cleanText(firstSnapshot?.id);
}

export function getActiveStatementSnapshot(financial: AnyObj | null | undefined): AnyObj | null {
  const snapshots = getStatementSnapshots(financial);
  if (!snapshots.length) return null;
  const activeSnapshotId = getActiveStatementSnapshotId(financial);
  if (activeSnapshotId) {
    const active = snapshots.find((snapshot) => cleanText(snapshot.id) === activeSnapshotId);
    if (active) return active;
  }
  return snapshots[0] ?? null;
}

export function getStatementPortfolio(financial: AnyObj | null | undefined): PortfolioData | null {
  const activeSnapshot = getActiveStatementSnapshot(financial);
  const candidate =
    asRecord(activeSnapshot?.canonical_v2) ??
    asRecord(financial?.portfolio) ??
    activeSnapshot;
  if (!candidate) return null;
  const normalized = normalizeStoredPortfolio(candidate as AnyObj) as PortfolioData;
  return hasHoldings(normalized) ? normalized : null;
}

export function getPlaidPortfolio(financial: AnyObj | null | undefined): PortfolioData | null {
  const plaidSource = getPlaidSource(financial);
  const aggregate = asRecord(plaidSource.aggregate);
  const candidate = asRecord(aggregate?.portfolio_data);
  if (!candidate) return null;
  const normalized = normalizeStoredPortfolio(candidate) as PortfolioData;
  return hasHoldings(normalized) ? normalized : null;
}

export function buildStatementSource(
  financial: AnyObj | null | undefined,
  snapshots: AnyObj[],
  activeSnapshotId: string,
  updatedAt: string
): AnyObj {
  const existing = getStatementSource(financial);
  return {
    ...existing,
    source_type: "statement",
    source_label: "Statement",
    is_editable: true,
    active_snapshot_id: activeSnapshotId,
    snapshot_count: snapshots.length,
    snapshots,
    updated_at: updatedAt,
  };
}

function buildPlaidMirrorSignature(plaidStatus: PlaidPortfolioStatusResponse): string {
  const itemSignature = (plaidStatus.items || [])
    .map((item) =>
      [
        item.item_id,
        item.last_synced_at || "",
        item.sync_status || "",
        item.status || "",
        item.accounts?.length || 0,
      ].join(":")
    )
    .sort()
    .join("|");
  return [
    plaidStatus.aggregate?.last_synced_at || "",
    plaidStatus.aggregate?.item_count || 0,
    plaidStatus.aggregate?.account_count || 0,
    itemSignature,
  ].join("::");
}

export function isPlaidMirrorStale(
  financial: AnyObj | null | undefined,
  plaidStatus: PlaidPortfolioStatusResponse | null | undefined
): boolean {
  if (!plaidStatus || !plaidStatus.configured) return false;
  const plaidSource = getPlaidSource(financial);
  const storedSignature = cleanText(plaidSource.signature);
  return storedSignature !== buildPlaidMirrorSignature(plaidStatus);
}

export function upsertPlaidSource(
  financial: AnyObj | null | undefined,
  plaidStatus: PlaidPortfolioStatusResponse,
  preferredSource: PortfolioSource,
  updatedAt: string
): AnyObj {
  const nextFinancial = { ...(financial ?? {}) };
  const nextSources = getSources(financial);
  const nextPlaidSource = {
    ...getPlaidSource(financial),
    source_type: "plaid",
    source_label: "Plaid",
    connection_type: "plaid_brokerage",
    is_editable: false,
    active_item_ids: (plaidStatus.items || []).map((item) => item.item_id).filter(Boolean),
    items: plaidStatus.items || [],
    aggregate: plaidStatus.aggregate || {},
    projected_at: updatedAt,
    projected_from_last_synced_at: plaidStatus.aggregate?.last_synced_at || null,
    sync_status: plaidStatus.aggregate?.sync_status || "idle",
    signature: buildPlaidMirrorSignature(plaidStatus),
  };

  const nextActiveSource =
    preferredSource === "plaid" || preferredSource === "statement"
      ? preferredSource
      : (cleanText(nextSources.active_source) as PortfolioSource | null) ?? "statement";

  nextFinancial.sources = {
    ...nextSources,
    active_source: nextActiveSource,
    plaid: nextPlaidSource,
  };

  if (
    nextActiveSource === "plaid" &&
    hasHoldings(plaidStatus.aggregate?.portfolio_data)
  ) {
    const plaidPortfolio = normalizeStoredPortfolio(
      plaidStatus.aggregate.portfolio_data as AnyObj
    ) as PortfolioData;
    nextFinancial.portfolio = plaidPortfolio;
    nextFinancial.analytics =
      asRecord((plaidStatus.aggregate?.portfolio_data as AnyObj | undefined)?.analytics_v2) ??
      asRecord(plaidPortfolio.analytics_v2) ??
      null;
  }

  nextFinancial.updated_at = updatedAt;
  return nextFinancial;
}

export function setActivePlaidSource(
  financial: AnyObj | null | undefined,
  plaidStatus: PlaidPortfolioStatusResponse | null | undefined,
  updatedAt: string
): AnyObj | null {
  const nextFinancial = { ...(financial ?? {}) };
  const nextSources = getSources(nextFinancial);
  const nextPlaidSource = getPlaidSource(nextFinancial);
  const aggregateFromStatus = plaidStatus?.aggregate
    ? (plaidStatus.aggregate as unknown as AnyObj)
    : null;
  const aggregate = aggregateFromStatus ?? asRecord(nextPlaidSource.aggregate);
  const candidate = asRecord(aggregate?.portfolio_data);
  if (!candidate) return null;

  const normalized = normalizeStoredPortfolio(candidate) as PortfolioData;
  nextFinancial.sources = {
    ...nextSources,
    active_source: "plaid",
    plaid: aggregateFromStatus
      ? {
          ...nextPlaidSource,
          source_type: "plaid",
          source_label: "Plaid",
          connection_type: "plaid_brokerage",
          is_editable: false,
          active_item_ids: (plaidStatus?.items || []).map((item) => item.item_id).filter(Boolean),
          items: plaidStatus?.items || [],
          aggregate,
          projected_at: updatedAt,
          projected_from_last_synced_at: plaidStatus?.aggregate?.last_synced_at || null,
          sync_status: plaidStatus?.aggregate?.sync_status || "idle",
          signature: plaidStatus ? buildPlaidMirrorSignature(plaidStatus) : cleanText(nextPlaidSource.signature),
        }
      : nextPlaidSource,
  };
  nextFinancial.portfolio = normalized;
  nextFinancial.analytics = getPortfolioAnalytics(candidate) ?? getPortfolioAnalytics(normalized as AnyObj);
  nextFinancial.updated_at = updatedAt;
  return nextFinancial;
}

export function setActiveStatementSnapshot(
  financial: AnyObj | null | undefined,
  snapshotId: string,
  updatedAt: string
): AnyObj | null {
  const snapshots = getStatementSnapshots(financial);
  const snapshot = snapshots.find((entry) => cleanText(entry.id) === snapshotId);
  if (!snapshot) return null;

  const nextFinancial = { ...(financial ?? {}) };
  const nextSources = getSources(financial);
  nextFinancial.sources = {
    ...nextSources,
    active_source: "statement",
    statement: buildStatementSource(financial, snapshots, snapshotId, updatedAt),
  };

  const canonical = asRecord(snapshot.canonical_v2) ?? snapshot;
  const normalized = normalizeStoredPortfolio(canonical) as PortfolioData;
  nextFinancial.portfolio = normalized;
  nextFinancial.analytics = getPortfolioAnalytics(snapshot) ?? getPortfolioAnalytics(canonical) ?? asRecord(financial?.analytics) ?? null;
  nextFinancial.updated_at = updatedAt;
  return nextFinancial;
}

type HoldingLike = {
  symbol?: string;
  name?: string;
  asset_type?: string;
  asset_class?: string;
  is_cash_equivalent?: boolean;
  market_value?: number;
};

function isCashEquivalentHolding(row: HoldingLike): boolean {
  if (row.is_cash_equivalent === true) return true;
  const hint = `${row.symbol || ""} ${row.name || ""} ${row.asset_type || ""}`.toLowerCase();
  return (
    hint.includes("cash") ||
    hint.includes("money market") ||
    hint.includes("sweep") ||
    hint.includes("retail prime") ||
    hint.includes("first american")
  );
}

function computeAllocationPct(holdings: HoldingLike[]): {
  cash: number;
  equities: number;
  bonds: number;
  other: number;
} {
  let totalValue = 0;
  let cashValue = 0;
  let equitiesValue = 0;
  let bondsValue = 0;

  for (const h of holdings) {
    const mv = typeof h.market_value === "number" ? h.market_value : 0;
    if (mv <= 0) continue;
    totalValue += mv;

    if (isCashEquivalentHolding(h)) {
      cashValue += mv;
      continue;
    }

    const assetType = String(h.asset_type || h.asset_class || "").toLowerCase();
    if (
      assetType.includes("bond") ||
      assetType.includes("fixed income") ||
      assetType.includes("treasury") ||
      assetType.includes("debt")
    ) {
      bondsValue += mv;
    } else {
      equitiesValue += mv;
    }
  }

  if (totalValue <= 0) return { cash: 0, equities: 0, bonds: 0, other: 0 };

  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  const cash = round4(cashValue / totalValue);
  const equities = round4(equitiesValue / totalValue);
  const bonds = round4(bondsValue / totalValue);
  const other = round4(Math.max(0, 1 - cash - equities - bonds));
  return { cash, equities, bonds, other };
}

export function buildFinancialDomainSummary(financial: AnyObj | null | undefined): AnyObj {
  const activeSource = cleanText(getSources(financial).active_source) ?? "statement";
  const statementSnapshots = getStatementSnapshots(financial);
  const plaidItems = asArray<AnyObj>(getPlaidSource(financial).items);
  const portfolio = getStatementPortfolio(financial) ?? (normalizeStoredPortfolio(asRecord(financial?.portfolio) ?? {}) as PortfolioData);
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];
  const accountInfo = asRecord(portfolio?.account_info);

  const cashHoldings = holdings.filter((h) => isCashEquivalentHolding(h));
  const investableHoldings = holdings.filter((h) => !isCashEquivalentHolding(h));
  const accountSummary = asRecord(portfolio?.account_summary);
  const riskProfile = cleanText(asRecord(financial)?.risk_profile) ?? cleanText(accountSummary?.risk_profile) ?? null;
  const allocationPct = computeAllocationPct(holdings);

  return {
    intent_source: "kai_portfolio_sources",
    active_source: activeSource,
    attribute_count: holdings.length,
    item_count: holdings.length,
    holdings_count: holdings.length,
    investable_positions_count: investableHoldings.length,
    cash_positions_count: cashHoldings.length,
    documents_count: statementSnapshots.length,
    plaid_item_count: plaidItems.length,
    risk_profile: riskProfile,
    asset_allocation_pct: allocationPct,
    last_brokerage:
      cleanText(accountInfo?.brokerage) ??
      cleanText(accountInfo?.brokerage_name) ??
      null,
    last_updated: cleanText(financial?.updated_at) ?? new Date().toISOString(),
  };
}
