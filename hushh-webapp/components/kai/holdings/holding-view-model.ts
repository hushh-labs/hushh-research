import type { Holding as PortfolioHolding } from "@/components/kai/types/portfolio";
import type { HoldingMobileCardViewModel } from "@/components/kai/holdings/holding-mobile-card";

export type HoldingsListItem = PortfolioHolding & {
  client_id: string;
  pending_delete?: boolean;
  entries?: HoldingsListItem[];
};

export function finiteNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function toHoldingViewModel(
  holding: HoldingsListItem,
  totalMarketValue: number,
  context?: { source?: string; statementAsOf?: string | null; valuationKind?: "statement" | "linked" },
): HoldingMobileCardViewModel {
  const explicitMarketValue = finiteNumber(holding.market_value);
  const marketValue = explicitMarketValue ?? 0;
  const shares = finiteNumber(holding.quantity) ?? 0;
  const costBasis = finiteNumber(holding.cost_basis);
  const gainLossValue =
    finiteNumber(holding.unrealized_gain_loss) ??
    (explicitMarketValue !== null && costBasis !== null
      ? explicitMarketValue - costBasis
      : null);
  const gainLossPct =
    finiteNumber(holding.unrealized_gain_loss_pct) ??
    (gainLossValue !== null && costBasis !== null && costBasis !== 0
      ? (gainLossValue / costBasis) * 100
      : null);
  const sector = String(
    holding.sector || holding.asset_type || holding.asset_class || "",
  ).trim();

  return {
    id: holding.client_id,
    symbol: String(holding.symbol || "").trim() || "—",
    name: String(holding.name || "").trim() || "Unnamed security",
    marketValue,
    shares,
    gainLossValue,
    gainLossPct,
    averagePrice:
      costBasis !== null && shares > 0
        ? costBasis / shares
        : null,
    currentPrice: holding.price_unavailable ? null : finiteNumber(holding.price),
    costBasis,
    acquisitionDate: holding.acquisition_date || null,
    source: holding.institution_name || context?.source || holding.source_type || null,
    quoteAsOf: holding.institution_price_as_of || null,
    statementAsOf: context?.statementAsOf || null,
    valuationKind: context?.valuationKind,
    identifierType: holding.identifier_type,
    portfolioWeightPct:
      totalMarketValue > 0 ? (marketValue / totalMarketValue) * 100 : 0,
    sector: sector || null,
    isCash: holding.is_cash_equivalent === true,
    pendingDelete: Boolean(holding.pending_delete),
  };
}
