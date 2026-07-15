import type { Holding, PortfolioData } from "@/components/kai/types/portfolio";

export type DashboardAssetBucket =
  | "cash_equivalent"
  | "equity"
  | "fixed_income"
  | "real_asset"
  | "other";

export interface DashboardPosition {
  id: string;
  rawSymbol: string;
  displaySymbol: string;
  tickerSymbol: string | null;
  identifierType: "ticker" | "cusip" | "unknown";
  name: string;
  marketValue: number;
  costBasis: number;
  quantity: number;
  price: number;
  gainLoss: number | null;
  gainLossPct: number | null;
  estimatedAnnualIncome: number | null;
  estimatedYield: number | null;
  sector: string | null;
  assetType: string | null;
  assetBucket: DashboardAssetBucket;
  isCashEquivalent: boolean;
  debateEligible: boolean;
  optimizeEligible: boolean;
  aliases: string[];
}

export interface DashboardAllocationBucket {
  key: DashboardAssetBucket;
  label: string;
  value: number;
  pct: number;
}

export interface DashboardSectorExposure {
  sector: string;
  value: number;
  pct: number;
  count: number;
}

export interface DashboardGainLossBand {
  label: string;
  count: number;
}

export interface DashboardPortfolioModel {
  generatedAt: string;
  sourceBrokerage?: string;
  statementPeriod?: string;
  beginningValue: number;
  endingValue: number;
  netChange: number;
  netChangePct: number;
  positions: DashboardPosition[];
  counts: {
    totalPositions: number;
    tickerPositions: number;
    investablePositions: number;
    cashPositions: number;
    fixedIncomePositions: number;
    realAssetPositions: number;
    equityPositions: number;
  };
  totals: {
    marketValue: number;
    cashValue: number;
    estimatedAnnualIncome: number;
  };
  summaryMetrics: {
    investmentGainLoss: number | null;
    totalIncomePeriod: number | null;
    totalIncomeYtd: number | null;
    totalFees: number | null;
    netDepositsPeriod: number | null;
    netDepositsYtd: number | null;
  };
  allocation: DashboardAllocationBucket[];
  sectorExposure: DashboardSectorExposure[];
  gainLossBands: DashboardGainLossBand[];
  debateContext: {
    eligibleSymbols: string[];
    excludedPositions: Array<{ symbol: string; reason: string }>;
  };
  optimizeContext: {
    losersCount: number;
    winnersCount: number;
    lossValue: number;
  };
  quality: {
    tickerCoveragePct: number;
    sectorCoveragePct: number;
    gainLossCoveragePct: number;
    incomeCoveragePct: number;
  };
}

const CUSIP_REGEX = /^[0-9A-Z]{9}$/;
const TICKER_REGEX = /^[A-Z]{1,6}$/;

const BUCKET_LABELS: Record<DashboardAssetBucket, string> = {
  cash_equivalent: "Cash",
  equity: "Equities",
  fixed_income: "Fixed Income",
  real_asset: "Real Assets",
  other: "Other",
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,%\s,]/g, "").trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toPositiveNumber(value: unknown): number {
  return Math.max(0, toNumber(value) ?? 0);
}

function toText(value: unknown): string {
  return String(value ?? "").trim();
}

function formatStatementPeriod(data: PortfolioData): string | undefined {
  const start = data.account_info?.statement_period_start;
  const end = data.account_info?.statement_period_end;
  if (!start || !end) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
  } catch {
    return undefined;
  }
}

function dedupeStrings(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const value = item.trim().toUpperCase();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function inferAliases(rawSymbol: string, name: string): string[] {
  const aliases = [rawSymbol];
  const dashMatch = name.match(/\-\s*([A-Z0-9]{2,10})\b/);
  if (dashMatch?.[1]) aliases.push(dashMatch[1]);

  const parenMatch = name.match(/\(([A-Z0-9]{1,10})\)/);
  if (parenMatch?.[1]) aliases.push(parenMatch[1]);

  return dedupeStrings(aliases);
}

function classifyAssetBucket({
  symbol,
  name,
  sector,
  assetType,
  instrumentKind,
  securityListingStatus,
  symbolKind,
  isSecCommonEquityTicker,
  hasTickerAlias,
  isCashEquivalent,
}: {
  symbol: string;
  name: string;
  sector: string;
  assetType: string;
  instrumentKind?: string;
  securityListingStatus?: string;
  symbolKind?: string;
  isSecCommonEquityTicker?: boolean;
  hasTickerAlias?: boolean;
  isCashEquivalent?: boolean;
}): DashboardAssetBucket {
  if (isCashEquivalent) return "cash_equivalent";
  const normalizedKind = String(instrumentKind || "").trim().toLowerCase();
  const normalizedListingStatus = String(securityListingStatus || "")
    .trim()
    .toLowerCase();
  const normalizedSymbolKind = String(symbolKind || "").trim().toLowerCase();
  if (normalizedKind === "cash_equivalent") return "cash_equivalent";
  if (normalizedKind === "fixed_income") return "fixed_income";
  if (normalizedKind === "real_asset") return "real_asset";
  if (normalizedKind === "equity") return "equity";
  if (normalizedListingStatus === "cash_or_sweep") return "cash_equivalent";
  if (normalizedListingStatus === "fixed_income") return "fixed_income";
  if (normalizedListingStatus === "sec_common_equity") return "equity";
  if (normalizedSymbolKind === "us_common_equity_ticker") return "equity";
  if (isSecCommonEquityTicker) return "equity";

  const hint = `${symbol} ${name} ${sector} ${assetType}`.toLowerCase();
  if (
    hint.includes("cash")
    || hint.includes("money market")
    || hint.includes("sweep")
    || hint.includes("retail prime")
    || hint.includes("first american")
    || hint.includes("fxrxx")
  ) {
    return "cash_equivalent";
  }
  if (
    hint.includes("fixed income")
    || hint.includes("bond")
    || hint.includes("treasury")
    || hint.includes("municipal")
    || hint.includes("tax free")
    || hint.includes("income fund")
  ) {
    return "fixed_income";
  }
  if (
    hint.includes("real asset")
    || hint.includes("real estate")
    || hint.includes("reit")
    || hint.includes("commod")
    || hint.includes("gold")
  ) {
    return "real_asset";
  }
  if (
    hint.includes("equity")
    || hint.includes("stock")
    || hint.includes("etf")
    || hint.includes("fund")
    || hint.includes("growth")
    || hint.includes("value")
    || hint.includes("market")
    || hint.includes("cap")
  ) {
    return "equity";
  }
  // Default ticker-like instruments to equity when no non-equity hints were found.
  if (hasTickerAlias) return "equity";
  return "other";
}

function toPosition(raw: Holding, index: number): DashboardPosition | null {
  const rawSymbol = toText(raw.symbol).toUpperCase();
  const name = toText(raw.name);
  if (!rawSymbol && !name) return null;

  const aliases = inferAliases(rawSymbol, name);
  const tickerAlias = aliases.find((alias) => TICKER_REGEX.test(alias)) ?? null;
  const explicitIdentifierType = toText(raw.identifier_type).toLowerCase();
  const identifierType: DashboardPosition["identifierType"] =
    explicitIdentifierType === "ticker"
      ? "ticker"
      : explicitIdentifierType === "cusip"
        ? "cusip"
        : tickerAlias
      ? "ticker"
      : CUSIP_REGEX.test(rawSymbol)
        ? "cusip"
        : "unknown";
  const displaySymbol = tickerAlias || rawSymbol || `POS-${index + 1}`;

  const sector = toText(raw.sector) || null;
  const assetType = toText(raw.asset_type || raw.asset_class) || null;
  const explicitCashEquivalent = Boolean(raw.is_cash_equivalent);
  const explicitInvestableRaw = raw.is_investable;
  const explicitInvestable =
    typeof explicitInvestableRaw === "boolean" ? explicitInvestableRaw : null;
  const assetBucket = classifyAssetBucket({
    symbol: rawSymbol,
    name,
    sector: sector || "",
    assetType: assetType || "",
    instrumentKind: toText(raw.instrument_kind),
    securityListingStatus: toText(raw.security_listing_status),
    symbolKind: toText(raw.symbol_kind),
    isSecCommonEquityTicker: Boolean(raw.is_sec_common_equity_ticker),
    hasTickerAlias: Boolean(tickerAlias),
    isCashEquivalent: explicitCashEquivalent,
  });
  const isCashEquivalent = explicitCashEquivalent || assetBucket === "cash_equivalent";
  const marketValue = toPositiveNumber(raw.market_value);

  const debateEligible =
    explicitInvestable !== null
      ? explicitInvestable && marketValue > 0
      : !isCashEquivalent && Boolean(tickerAlias) && marketValue > 0;
  const optimizeEligible = debateEligible;

  return {
    id: `${displaySymbol}-${index}`,
    rawSymbol,
    displaySymbol,
    tickerSymbol: tickerAlias,
    identifierType,
    name: name || displaySymbol,
    marketValue,
    costBasis: toPositiveNumber(raw.cost_basis),
    quantity: toPositiveNumber(raw.quantity),
    price: toPositiveNumber(raw.price),
    gainLoss: toNumber(raw.unrealized_gain_loss),
    gainLossPct: toNumber(raw.unrealized_gain_loss_pct),
    estimatedAnnualIncome: toNumber(raw.estimated_annual_income),
    estimatedYield: toNumber(raw.est_yield),
    sector,
    assetType,
    assetBucket,
    isCashEquivalent,
    debateEligible,
    optimizeEligible,
    aliases,
  };
}

export function buildDashboardPortfolioModel(portfolioData: PortfolioData): DashboardPortfolioModel {
  const rawHoldings = (portfolioData.holdings || []) as Holding[];
  const positions = rawHoldings
    .map((holding, index) => toPosition(holding, index))
    .filter((row): row is DashboardPosition => Boolean(row))
    .sort((a, b) => b.marketValue - a.marketValue);

  const endingValue =
    toPositiveNumber(portfolioData.total_value)
    || toPositiveNumber(portfolioData.account_summary?.ending_value)
    || positions.reduce((sum, row) => sum + row.marketValue, 0);
  const beginningValue = toPositiveNumber(portfolioData.account_summary?.beginning_value) || endingValue;
  const netChange =
    toNumber(portfolioData.account_summary?.change_in_value)
    ?? (endingValue - beginningValue);
  const netChangePct = beginningValue > 0 ? (netChange / beginningValue) * 100 : 0;

  const totals = {
    marketValue: endingValue,
    cashValue: positions
      .filter((position) => position.isCashEquivalent)
      .reduce((sum, position) => sum + position.marketValue, 0),
    estimatedAnnualIncome: positions.reduce(
      (sum, position) => sum + (position.estimatedAnnualIncome ?? 0),
      0
    ),
  };
  const accountSummary: Record<string, unknown> =
    portfolioData.account_summary && typeof portfolioData.account_summary === "object"
      ? (portfolioData.account_summary as unknown as Record<string, unknown>)
      : {};
  const incomeSummary =
    portfolioData.income_summary && typeof portfolioData.income_summary === "object"
      ? portfolioData.income_summary
      : {};
  const cashFlow =
    portfolioData.cash_flow && typeof portfolioData.cash_flow === "object"
      ? portfolioData.cash_flow
      : {};
  const summaryMetrics = {
    investmentGainLoss:
      toNumber(accountSummary.investment_gain_loss)
      ?? toNumber((accountSummary as Record<string, unknown>).total_change)
      ?? toNumber(accountSummary.change_in_value),
    totalIncomePeriod:
      toNumber(accountSummary.total_income_period)
      ?? toNumber((incomeSummary as Record<string, unknown>).total_income)
      ?? toNumber((cashFlow as Record<string, unknown>).dividends_received)
      ?? toNumber((cashFlow as Record<string, unknown>).interest_received),
    totalIncomeYtd:
      toNumber(accountSummary.total_income_ytd)
      ?? toNumber((incomeSummary as Record<string, unknown>).total_income_ytd),
    totalFees:
      toNumber(accountSummary.total_fees)
      ?? toNumber((cashFlow as Record<string, unknown>).fees_paid),
    netDepositsPeriod:
      toNumber(accountSummary.net_deposits_period)
      ?? toNumber(accountSummary.net_deposits_withdrawals),
    netDepositsYtd: toNumber(accountSummary.net_deposits_ytd),
  };

  const counts = {
    totalPositions: positions.length,
    tickerPositions: positions.filter((position) => Boolean(position.tickerSymbol)).length,
    investablePositions: positions.filter((position) => position.debateEligible).length,
    cashPositions: positions.filter((position) => position.assetBucket === "cash_equivalent").length,
    fixedIncomePositions: positions.filter((position) => position.assetBucket === "fixed_income").length,
    realAssetPositions: positions.filter((position) => position.assetBucket === "real_asset").length,
    equityPositions: positions.filter((position) => position.assetBucket === "equity").length,
  };

  const allocationBuckets: DashboardAllocationBucket[] = (
    ["equity", "fixed_income", "cash_equivalent", "real_asset", "other"] as DashboardAssetBucket[]
  )
    .map((key) => {
      const value = positions
        .filter((position) => position.assetBucket === key)
        .reduce((sum, position) => sum + position.marketValue, 0);
      return {
        key,
        label: BUCKET_LABELS[key],
        value,
        pct: endingValue > 0 ? (value / endingValue) * 100 : 0,
      };
    })
    .filter((row) => row.value > 0);

  const sectorMap = new Map<string, { value: number; count: number }>();
  for (const position of positions) {
    if (position.isCashEquivalent) continue;
    const sectorKey = position.sector || BUCKET_LABELS[position.assetBucket];
    const existing = sectorMap.get(sectorKey) || { value: 0, count: 0 };
    sectorMap.set(sectorKey, {
      value: existing.value + position.marketValue,
      count: existing.count + 1,
    });
  }
  const sectorExposure = Array.from(sectorMap.entries())
    .map(([sector, value]) => ({
      sector,
      value: value.value,
      count: value.count,
      pct: endingValue > 0 ? (value.value / endingValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const gainLossBands = [
    { label: "< -10%", min: Number.NEGATIVE_INFINITY, max: -10, count: 0 },
    { label: "-10% to -2%", min: -10, max: -2, count: 0 },
    { label: "-2% to +2%", min: -2, max: 2, count: 0 },
    { label: "+2% to +10%", min: 2, max: 10, count: 0 },
    { label: "> +10%", min: 10, max: Number.POSITIVE_INFINITY, count: 0 },
  ];
  for (const position of positions) {
    const gainLossPct = position.gainLossPct;
    if (gainLossPct === null) continue;
    const bucket = gainLossBands.find(
      (entry) => gainLossPct > entry.min && gainLossPct <= entry.max
    );
    if (bucket) bucket.count += 1;
  }

  const investablePositions = positions.filter((position) => position.debateEligible);
  const excludedPositions = positions
    .filter((position) => !position.debateEligible)
    .map((position) => ({
      symbol: position.displaySymbol,
      reason: position.isCashEquivalent
        ? "cash_equivalent"
        : !position.tickerSymbol
          ? "missing_ticker_alias"
          : "not_eligible",
    }));

  const losers = positions.filter((position) => (position.gainLoss ?? 0) < 0);
  const winners = positions.filter((position) => (position.gainLoss ?? 0) > 0);

  const nonCashPositions = positions.filter((position) => !position.isCashEquivalent);
  const nonCashCount = Math.max(1, nonCashPositions.length);
  const quality = {
    tickerCoveragePct:
      nonCashPositions.filter((position) => Boolean(position.tickerSymbol)).length / nonCashCount,
    sectorCoveragePct:
      nonCashPositions.filter((position) => Boolean(position.sector)).length / nonCashCount,
    gainLossCoveragePct:
      nonCashPositions.filter((position) => position.gainLossPct !== null).length / nonCashCount,
    incomeCoveragePct:
      nonCashPositions.filter((position) => position.estimatedAnnualIncome !== null).length / nonCashCount,
  };

  return {
    generatedAt: new Date().toISOString(),
    sourceBrokerage:
      portfolioData.account_info?.brokerage_name
      || (portfolioData.account_info as { brokerage?: string } | undefined)?.brokerage
      || portfolioData.account_info?.institution_name,
    statementPeriod: formatStatementPeriod(portfolioData),
    beginningValue,
    endingValue,
    netChange,
    netChangePct,
    positions,
    counts,
    totals,
    summaryMetrics,
    allocation: allocationBuckets,
    sectorExposure,
    gainLossBands: gainLossBands.map(({ label, count }) => ({ label, count })),
    debateContext: {
      eligibleSymbols: investablePositions
        .map((position) => position.tickerSymbol || position.displaySymbol)
        .filter((symbol, index, arr) => Boolean(symbol) && arr.indexOf(symbol) === index)
        .slice(0, 20),
      excludedPositions,
    },
    optimizeContext: {
      losersCount: losers.length,
      winnersCount: winners.length,
      lossValue: losers.reduce((sum, position) => sum + position.marketValue, 0),
    },
    quality,
  };
}
