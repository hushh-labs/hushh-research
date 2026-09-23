"use client";

import type { PortfolioData } from "@/components/kai/types/portfolio";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";
import { toPortfolioData as toVaultPortfolioData } from "@/lib/kai/plaid-vault/projection";

import type {
  PortfolioSource,
  StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";

type AnyObj = Record<string, unknown>;

export type FinancialCompatibilityView = {
  storageContract: "v6" | "v7";
  activeSource: PortfolioSource;
  statementPortfolio: PortfolioData | null;
  plaidPortfolio: PortfolioData | null;
  activePortfolio: PortfolioData | null;
  profile: AnyObj;
  durableDecisions: AnyObj[];
  sourceArtifactRefs: string[];
};

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

function getPortfolioAnalytics(portfolio: AnyObj | null | undefined): AnyObj | null {
  return asRecord(portfolio?.analytics_v2) ?? null;
}

function getFinancialCoreV7(financial: AnyObj | null | undefined): AnyObj | null {
  const contract = cleanText(financial?.pkm_contract_version);
  if (!contract?.startsWith("7.")) return null;
  return asRecord(financial?.financial_core_v7);
}

function buildFinancialCoreV7Portfolio(
  financial: AnyObj | null | undefined
): PortfolioData | null {
  const core = getFinancialCoreV7(financial);
  if (!core) return null;
  const securities = asRecord(core.securities) ?? {};
  const positions = asRecord(core.positions) ?? {};
  const holdings = Object.entries(positions).map(([positionId, rawPosition]) => {
    const position = asRecord(rawPosition) ?? {};
    const securityId = cleanText(position.security_id);
    const security = securityId ? asRecord(securities[securityId]) ?? {} : {};
    return {
      ...security,
      ...position,
      position_id: positionId,
      security_id: securityId,
      account_id: cleanText(position.account_id),
      symbol: cleanText(security.symbol) ?? cleanText(position.symbol) ?? "",
    };
  });
  const portfolio = normalizeStoredPortfolio({
    holdings,
    account_summary: asRecord(core.account_summary) ?? {},
    total_value: core.total_value,
    cash_balance: core.cash_balance,
  }) as PortfolioData;
  return hasHoldings(portfolio) ? portfolio : null;
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
  const v7Artifacts = asRecord(financial?.source_artifacts_v7);
  const v7StatementSnapshots = asArray<AnyObj>(v7Artifacts?.statement_snapshots);
  if (v7StatementSnapshots.length > 0) {
    return v7StatementSnapshots.filter(
      (snapshot) => cleanText(snapshot.id) && cleanText(snapshot.artifact_ref)
    );
  }
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
  const v7ActiveSource = cleanText(getFinancialCoreV7(financial)?.active_source);
  if (v7ActiveSource === "plaid" || v7ActiveSource === "statement") {
    return v7ActiveSource;
  }
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
  const v7Portfolio = buildFinancialCoreV7Portfolio(financial);
  if (v7Portfolio && getActiveSource(financial) === "statement") return v7Portfolio;
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
  // Connections sealed in the vault carry their own holdings in memory.
  const connections = asRecord(financial?.connections_v1);
  if (connections && Object.keys(connections).length > 0) {
    const vaultPortfolio = toVaultPortfolioData(financial ?? {});
    if (vaultPortfolio && hasHoldings(vaultPortfolio)) return vaultPortfolio;
  }
  const v7Portfolio = buildFinancialCoreV7Portfolio(financial);
  if (v7Portfolio && getActiveSource(financial) === "plaid") return v7Portfolio;
  return null;
}

export function getFinancialCompatibilityView(
  financial: AnyObj | null | undefined
): FinancialCompatibilityView {
  const core = getFinancialCoreV7(financial);
  const activeSource = getActiveSource(financial);
  const statementPortfolio = getStatementPortfolio(financial);
  const plaidPortfolio = getPlaidPortfolio(financial);
  const activePortfolio = activeSource === "plaid" ? plaidPortfolio : statementPortfolio;
  const artifactRoot = asRecord(financial?.source_artifacts_v7) ?? {};
  const sourceArtifactRefs = Object.values(artifactRoot)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(asRecord)
    .filter((value): value is AnyObj => value !== null)
    .map((value) => cleanText(value.artifact_ref))
    .filter((value): value is string => Boolean(value));
  return {
    storageContract: core ? "v7" : "v6",
    activeSource,
    statementPortfolio,
    plaidPortfolio,
    activePortfolio,
    profile: core ? asRecord(core.profile) ?? {} : asRecord(financial?.profile) ?? {},
    durableDecisions: core
      ? asArray<AnyObj>(core.durable_decisions)
      : asArray<AnyObj>(financial?.durable_decisions),
    sourceArtifactRefs: [...new Set(sourceArtifactRefs)],
  };
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

/**
 * Plaid connections live in the vault tiers (`connections_v1` and siblings);
 * the older `sources.plaid` copy of the server's Plaid status is retired and
 * dropped on the next save.
 */
function withoutRetiredPlaidCopy(sources: AnyObj): AnyObj {
  const next = { ...sources };
  delete next.plaid;
  return next;
}

/** Makes the vault's Plaid holdings the active portfolio; null when there are none. */
export function setActivePlaidSource(
  financial: AnyObj | null | undefined,
  updatedAt: string
): AnyObj | null {
  const plaidPortfolio = getPlaidPortfolio(financial);
  if (!plaidPortfolio) return null;
  const nextFinancial = { ...(financial ?? {}) };
  nextFinancial.sources = {
    ...withoutRetiredPlaidCopy(getSources(nextFinancial)),
    active_source: "plaid",
  };
  nextFinancial.portfolio = plaidPortfolio;
  nextFinancial.analytics = getPortfolioAnalytics(plaidPortfolio as AnyObj);
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

export function removeStatementSnapshot(
  financial: AnyObj | null | undefined,
  snapshotId: string,
  updatedAt: string
): AnyObj | null {
  const targetSnapshotId = cleanText(snapshotId);
  if (!targetSnapshotId) return null;

  const snapshots = getStatementSnapshots(financial);
  const remainingSnapshots = snapshots.filter((entry) => cleanText(entry.id) !== targetSnapshotId);
  if (remainingSnapshots.length === snapshots.length) return null;

  const nextFinancial = { ...(financial ?? {}) };
  const nextSources = { ...getSources(financial) };
  const nextDocuments = {
    ...(asRecord(financial?.documents) ?? {}),
    schema_version: 1,
    statements: remainingSnapshots,
    documents_count: remainingSnapshots.length,
    last_updated: updatedAt,
  };
  nextFinancial.documents = nextDocuments;

  if (remainingSnapshots.length > 0) {
    const currentActiveId = getActiveStatementSnapshotId(financial);
    const nextActiveId =
      currentActiveId && currentActiveId !== targetSnapshotId
        ? currentActiveId
        : cleanText(remainingSnapshots[0]?.id);
    if (!nextActiveId) return null;
    const activeSnapshot =
      remainingSnapshots.find((entry) => cleanText(entry.id) === nextActiveId) ??
      remainingSnapshots[0];
    if (!activeSnapshot) return null;
    const canonical = asRecord(activeSnapshot?.canonical_v2) ?? activeSnapshot;
    const normalized = normalizeStoredPortfolio(canonical) as PortfolioData;
    nextFinancial.sources = {
      ...nextSources,
      active_source: "statement",
      statement: buildStatementSource(financial, remainingSnapshots, nextActiveId, updatedAt),
    };
    nextFinancial.portfolio = normalized;
    nextFinancial.analytics =
      getPortfolioAnalytics(activeSnapshot) ??
      getPortfolioAnalytics(canonical) ??
      asRecord(financial?.analytics) ??
      null;
    nextFinancial.updated_at = updatedAt;
    return nextFinancial;
  }

  const plaidPortfolio = getPlaidPortfolio(financial);
  nextFinancial.sources = {
    ...withoutRetiredPlaidCopy(nextSources),
    active_source: plaidPortfolio ? "plaid" : "statement",
    statement: {
      ...getStatementSource(financial),
      source_type: "statement",
      source_label: "Statement",
      is_editable: true,
      active_snapshot_id: null,
      snapshot_count: 0,
      snapshots: [],
      updated_at: updatedAt,
    },
  };

  if (plaidPortfolio) {
    nextFinancial.portfolio = plaidPortfolio;
    nextFinancial.analytics = getPortfolioAnalytics(plaidPortfolio as AnyObj);
  } else {
    delete nextFinancial.portfolio;
    delete nextFinancial.analytics;
  }

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
  const plaidConnections = asRecord(financial?.connections_v1) ?? {};
  const portfolio =
    (activeSource === "plaid" ? getPlaidPortfolio(financial) : null) ??
    getStatementPortfolio(financial) ??
    (normalizeStoredPortfolio(asRecord(financial?.portfolio) ?? {}) as PortfolioData);
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
    plaid_item_count: Object.keys(plaidConnections).length,
    risk_profile: riskProfile,
    asset_allocation_pct: allocationPct,
    last_brokerage:
      cleanText(accountInfo?.brokerage) ??
      cleanText(accountInfo?.brokerage_name) ??
      null,
    last_updated: cleanText(financial?.updated_at) ?? new Date().toISOString(),
  };
}
