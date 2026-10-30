import type { Holding, PortfolioData } from "@/components/kai/types/portfolio";
import {
  type DashboardPortfolioModel,
  type DashboardPosition,
  buildDashboardPortfolioModel,
} from "@/components/kai/views/dashboard-portfolio-model";

export interface AllocationDatum {
  name: string;
  value: number;
  color: string;
}

export interface HistoryDatum {
  date: string;
  value: number;
}

export interface ConcentrationDatum {
  symbol: string;
  name: string;
  marketValue: number;
  weightPct: number;
}

export interface GainLossBandDatum {
  band: string;
  count: number;
}

export interface DashboardRecommendation {
  title: string;
  detail: string;
}

export interface DashboardHeroData {
  totalValue: number;
  beginningValue: number;
  endingValue: number;
  netChange: number;
  changePct: number;
  holdingsCount: number;
  investableHoldingsCount: number;
  cashPositionsCount: number;
  portfolioConcentrationLabel: string;
  statementPeriod?: string;
}

export interface DashboardQualityFlags {
  allocationReady: boolean;
  sectorReady: boolean;
  historyReady: boolean;
  concentrationReady: boolean;
  gainLossReady: boolean;
  sectorCoveragePct: number;
  gainLossCoveragePct: number;
}

export interface DashboardSummaryMetrics {
  investmentGainLoss: number | null;
  totalIncomePeriod: number | null;
  totalIncomeYtd: number | null;
  totalFees: number | null;
  netDepositsPeriod: number | null;
  netDepositsYtd: number | null;
}

export interface DashboardEquitySectorAllocationDatum {
  sector: string;
  value: number;
  pct: number;
  count: number;
}

export interface DashboardNonEquityAllocationDatum {
  bucket: string;
  value: number;
  pct: number;
  count: number;
}

export interface DashboardAllocationQuality {
  equityCoveragePct: number;
  nonEquityCoveragePct: number;
}

export interface DashboardViewModel {
  hero: DashboardHeroData;
  holdings: Holding[];
  allocation: AllocationDatum[];
  equity_sector_allocation: DashboardEquitySectorAllocationDatum[];
  non_equity_allocation: DashboardNonEquityAllocationDatum[];
  allocation_denominator_total_value: number;
  allocation_quality: DashboardAllocationQuality;
  history: HistoryDatum[];
  concentration: ConcentrationDatum[];
  gainLossDistribution: GainLossBandDatum[];
  recommendations: DashboardRecommendation[];
  sourceBrokerage?: string;
  quality: DashboardQualityFlags;
  summaryMetrics: DashboardSummaryMetrics;
  canonicalModel: DashboardPortfolioModel;
}

const ALLOCATION_COLORS: Record<string, string> = {
  Equities: "#2563eb",
  "Fixed Income": "#0ea5e9",
  Cash: "#14b8a6",
  "Real Assets": "#f59e0b",
  Other: "#8b5cf6",
};

const GENERIC_SECTOR_LABELS = new Set([
  "equity",
  "equities",
  "stock",
  "stocks",
  "fixed income",
  "bond",
  "bonds",
  "cash",
  "cash & cash equivalents",
  "other",
  "unknown",
  "unclassified",
]);

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,%\s,]/g, "").trim();
    if (!cleaned) return undefined;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSpecificSectorLabel(value: string | null | undefined): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  return !GENERIC_SECTOR_LABELS.has(text.toLowerCase());
}

function classifyNonEquityBucket(position: DashboardPosition): string {
  if (position.isCashEquivalent || position.assetBucket === "cash_equivalent") {
    return "Cash & Cash Equivalents";
  }
  const hint = `${position.name} ${position.assetType || ""} ${position.sector || ""}`.toLowerCase();
  if (position.assetBucket === "fixed_income") {
    if (
      hint.includes("tax free")
      || hint.includes("municipal")
      || hint.includes("muni")
      || hint.includes("non-taxable")
      || hint.includes("tax-exempt")
    ) {
      return "Fixed Income Tax-Exempt";
    }
    return "Fixed Income Taxable";
  }
  if (position.assetBucket === "real_asset") {
    if (hint.includes("gold") || hint.includes("commodity")) {
      return "Commodities";
    }
    return "Real Assets";
  }
  return "Other";
}

function computeDetailedAllocation(model: DashboardPortfolioModel): {
  equitySectorAllocation: DashboardEquitySectorAllocationDatum[];
  nonEquityAllocation: DashboardNonEquityAllocationDatum[];
  denominator: number;
  quality: DashboardAllocationQuality;
} {
  const denominator = model.totals.marketValue > 0 ? model.totals.marketValue : 0;
  const equityPositions = model.positions.filter(
    (position) => !position.isCashEquivalent && position.assetBucket === "equity"
  );
  const nonEquityPositions = model.positions.filter(
    (position) => position.isCashEquivalent || position.assetBucket !== "equity"
  );

  const equityMap = new Map<string, { value: number; count: number }>();
  for (const position of equityPositions) {
    const sector =
      (isSpecificSectorLabel(position.sector) ? String(position.sector).trim() : "")
      || "Other Equity";
    const existing = equityMap.get(sector) || { value: 0, count: 0 };
    equityMap.set(sector, {
      value: existing.value + position.marketValue,
      count: existing.count + 1,
    });
  }

  const nonEquityMap = new Map<string, { value: number; count: number }>();
  for (const position of nonEquityPositions) {
    const bucket = classifyNonEquityBucket(position);
    const existing = nonEquityMap.get(bucket) || { value: 0, count: 0 };
    nonEquityMap.set(bucket, {
      value: existing.value + position.marketValue,
      count: existing.count + 1,
    });
  }

  const equitySectorAllocation = Array.from(equityMap.entries())
    .map(([sector, value]) => ({
      sector,
      value: value.value,
      count: value.count,
      pct: denominator > 0 ? (value.value / denominator) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const nonEquityAllocation = Array.from(nonEquityMap.entries())
    .map(([bucket, value]) => ({
      bucket,
      value: value.value,
      count: value.count,
      pct: denominator > 0 ? (value.value / denominator) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    equitySectorAllocation,
    nonEquityAllocation,
    denominator,
    quality: {
      equityCoveragePct:
        equityPositions.length > 0
          ? equityPositions.filter((position) => isSpecificSectorLabel(position.sector)).length
            / equityPositions.length
          : 1,
      nonEquityCoveragePct: nonEquityPositions.length > 0 ? 1 : 1,
    },
  };
}

function derivePortfolioConcentrationLabel(concentration: ConcentrationDatum[]): string {
  if (!concentration.length) return "Unknown";
  const largestWeight = concentration[0]?.weightPct || 0;
  if (largestWeight >= 40) return "High Concentration";
  if (largestWeight >= 25) return "Medium Concentration";
  return "Diversified";
}

function computeHistory(data: PortfolioData, beginningValue: number, endingValue: number): HistoryDatum[] {
  const raw = Array.isArray(data.historical_values) ? data.historical_values : [];
  const mapped = raw
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const entry = row as Record<string, unknown>;
      const date =
        (typeof entry.date === "string" && entry.date) ||
        (typeof entry.as_of === "string" && entry.as_of) ||
        (typeof entry.period === "string" && entry.period) ||
        "";
      const value =
        toNumber(entry.value) ??
        toNumber(entry.portfolio_value) ??
        toNumber(entry.total_value) ??
        toNumber(entry.ending_value);
      if (!date || value === undefined) return null;
      return { date, value };
    })
    .filter((row): row is HistoryDatum => Boolean(row));

  if (mapped.length >= 2) {
    return mapped;
  }

  if (beginningValue > 0 || endingValue > 0) {
    const startLabel = data.account_info?.statement_period_start || "Start";
    const endLabel = data.account_info?.statement_period_end || "End";
    return [
      { date: startLabel, value: beginningValue || endingValue },
      { date: endLabel, value: endingValue || beginningValue },
    ];
  }

  return [];
}

function computeRecommendations(model: DashboardPortfolioModel): DashboardRecommendation[] {
  const recommendations: DashboardRecommendation[] = [];
  const totalValue = model.totals.marketValue;
  const biggest = model.positions[0];

  if (biggest && totalValue > 0) {
    const biggestWeight = (biggest.marketValue / totalValue) * 100;
    if (biggestWeight >= 35) {
      recommendations.push({
        title: `Reduce ${biggest.displaySymbol} concentration`,
        detail: `${biggest.displaySymbol} is ${biggestWeight.toFixed(
          1
        )}% of portfolio value.`,
      });
    }
  }

  if (model.optimizeContext.losersCount > 0) {
    recommendations.push({
      title: "Review underperforming positions",
      detail: `${model.optimizeContext.losersCount} holding${
        model.optimizeContext.losersCount === 1 ? "" : "s"
      } currently have unrealized losses.`,
    });
  }

  if (model.counts.cashPositions > 0 && totalValue > 0) {
    const cashPct = (model.totals.cashValue / totalValue) * 100;
    recommendations.push({
      title: "Evaluate cash-equivalent exposure",
      detail: `Cash-equivalent allocation is ${cashPct.toFixed(
        1
      )}% of portfolio. Validate this against your liquidity plan.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      title: "Maintain current strategy",
      detail: "No major concentration or drawdown flags detected from current statement data.",
    });
  }

  return recommendations.slice(0, 3);
}

export function mapPortfolioToDashboardViewModel(portfolioData: PortfolioData): DashboardViewModel {
  const canonicalModel = buildDashboardPortfolioModel(portfolioData);
  const analytics = isRecord(portfolioData.analytics_v2)
    ? (portfolioData.analytics_v2 as Record<string, unknown>)
    : undefined;
  const detailedAllocation = computeDetailedAllocation(canonicalModel);

  const holdings = canonicalModel.positions.map((position) => ({
    symbol: position.displaySymbol,
    name: position.name,
    quantity: position.quantity,
    price: position.price,
    market_value: position.marketValue,
    cost_basis: position.costBasis,
    unrealized_gain_loss: position.gainLoss ?? undefined,
    unrealized_gain_loss_pct: position.gainLossPct ?? undefined,
    estimated_annual_income: position.estimatedAnnualIncome ?? undefined,
    est_yield: position.estimatedYield ?? undefined,
    sector: position.sector || undefined,
    asset_type: position.assetType || position.assetBucket,
  })) as Holding[];

  const allocationMix = Array.isArray(analytics?.allocation_mix)
    ? (analytics?.allocation_mix as Array<Record<string, unknown>>)
    : [];
  const allocation =
    allocationMix.length > 0
      ? allocationMix
          .map((row) => {
            const bucket = String(row.bucket || "").trim();
            const value = toNumber(row.value) ?? 0;
            if (!bucket || value <= 0) return null;
            const label =
              bucket === "cash_equivalent"
                ? "Cash"
                : bucket === "fixed_income"
                  ? "Fixed Income"
                  : bucket === "real_asset"
                    ? "Real Assets"
                    : bucket === "equity"
                      ? "Equities"
                      : "Other";
            return {
              name: label,
              value,
              color: ALLOCATION_COLORS[label] || "#2563eb",
            };
          })
          .filter((row): row is AllocationDatum => Boolean(row))
      : canonicalModel.allocation.map((bucket) => ({
          name: bucket.label,
          value: bucket.value,
          color: ALLOCATION_COLORS[bucket.label] || "#2563eb",
        }));

  const history = computeHistory(
    portfolioData,
    canonicalModel.beginningValue,
    canonicalModel.endingValue
  );

  const concentrationRaw = Array.isArray(analytics?.concentration)
    ? (analytics?.concentration as Array<Record<string, unknown>>)
    : [];
  const concentration =
    concentrationRaw.length > 0
      ? concentrationRaw
          .map((row) => ({
            symbol: String(row.symbol || "").trim(),
            name: String(row.name || row.symbol || "").trim(),
            marketValue: toNumber(row.market_value) ?? 0,
            weightPct: toNumber(row.weight_pct) ?? 0,
          }))
          .filter((row) => row.symbol && row.marketValue > 0)
          .slice(0, 8)
      : canonicalModel.positions
          .filter((position) => position.marketValue > 0)
          .slice(0, 8)
          .map((position) => ({
            symbol: position.displaySymbol,
            name: position.name,
            marketValue: position.marketValue,
            weightPct:
              canonicalModel.totals.marketValue > 0
                ? (position.marketValue / canonicalModel.totals.marketValue) * 100
                : 0,
          }));

  const gainLossRaw = Array.isArray(analytics?.gain_loss_distribution)
    ? (analytics?.gain_loss_distribution as Array<Record<string, unknown>>)
    : [];
  const gainLossDistribution =
    gainLossRaw.length > 0
      ? gainLossRaw.map((row) => ({
          band: String(row.band || "").trim() || "Unknown",
          count: Number(toNumber(row.count) ?? 0),
        }))
      : canonicalModel.gainLossBands.map((band) => ({
          band: band.label,
          count: band.count,
        }));

  const quality: DashboardQualityFlags = {
    allocationReady: allocation.length >= 2,
    sectorReady:
      canonicalModel.counts.investablePositions > 0 && canonicalModel.quality.sectorCoveragePct >= 0.35,
    historyReady: history.length >= 2,
    concentrationReady: concentration.length >= 3,
    gainLossReady:
      gainLossDistribution.some((row) => row.count > 0) && canonicalModel.quality.gainLossCoveragePct >= 0.35,
    sectorCoveragePct: canonicalModel.quality.sectorCoveragePct,
    gainLossCoveragePct: canonicalModel.quality.gainLossCoveragePct,
  };

  return {
    hero: {
      totalValue: canonicalModel.totals.marketValue,
      beginningValue: canonicalModel.beginningValue,
      endingValue: canonicalModel.endingValue,
      netChange: canonicalModel.netChange,
      changePct: canonicalModel.netChangePct,
      holdingsCount: canonicalModel.counts.totalPositions,
      investableHoldingsCount: canonicalModel.counts.investablePositions,
      cashPositionsCount: canonicalModel.counts.cashPositions,
      portfolioConcentrationLabel: derivePortfolioConcentrationLabel(concentration),
      statementPeriod: canonicalModel.statementPeriod,
    },
    holdings,
    allocation,
    equity_sector_allocation: detailedAllocation.equitySectorAllocation,
    non_equity_allocation: detailedAllocation.nonEquityAllocation,
    allocation_denominator_total_value: detailedAllocation.denominator,
    allocation_quality: detailedAllocation.quality,
    history,
    concentration,
    gainLossDistribution,
    recommendations: computeRecommendations(canonicalModel),
    sourceBrokerage: canonicalModel.sourceBrokerage,
    quality,
    summaryMetrics: canonicalModel.summaryMetrics,
    canonicalModel,
  };
}
