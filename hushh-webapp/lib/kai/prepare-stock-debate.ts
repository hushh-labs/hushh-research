import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import type { PortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";

const TICKER_SYMBOL_REGEX = /^[A-Z][A-Z0-9.\-]{0,5}$/;

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,%\s,]/g, "").trim();
    if (!cleaned) return undefined;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isCashEquivalentRow(row: {
  symbol: string;
  name: string;
  asset_type?: string;
}): boolean {
  const hint = `${row.symbol} ${row.name} ${row.asset_type || ""}`.toLowerCase();
  return (
    hint.includes("cash") ||
    hint.includes("sweep") ||
    hint.includes("money market") ||
    hint.includes("retail prime") ||
    hint.includes("first american") ||
    hint.includes("fxrxx")
  );
}

function pickFirstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractDebatePortfolioContext(
  userId: string,
  source?: Record<string, unknown> | null
): Record<string, unknown> | null {
  const cache = CacheService.getInstance();
  const cached =
    source ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) return null;

  const holdingsRaw = Array.isArray(cached.holdings)
    ? cached.holdings
    : cached.portfolio &&
        typeof cached.portfolio === "object" &&
        !Array.isArray(cached.portfolio) &&
        Array.isArray((cached.portfolio as Record<string, unknown>).holdings)
      ? ((cached.portfolio as Record<string, unknown>).holdings as unknown[])
      : [];

  const holdings = holdingsRaw
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .slice(0, 30)
    .map((row) => ({
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      name: String(row.name ?? "").trim(),
      quantity: toFiniteNumber(row.quantity),
      market_value: toFiniteNumber(row.market_value),
      position_side:
        typeof row.position_side === "string" &&
        ["long", "short", "liability"].includes(row.position_side.trim().toLowerCase())
          ? row.position_side.trim().toLowerCase()
          : undefined,
      is_short_position:
        typeof row.is_short_position === "boolean" ? row.is_short_position : undefined,
      is_liability_position:
        typeof row.is_liability_position === "boolean" ? row.is_liability_position : undefined,
      unrealized_gain_loss_pct: toFiniteNumber(row.unrealized_gain_loss_pct),
      sector: typeof row.sector === "string" ? row.sector : undefined,
      asset_type:
        typeof row.asset_type === "string"
          ? row.asset_type
          : typeof row.asset_class === "string"
            ? row.asset_class
            : undefined,
      is_investable: typeof row.is_investable === "boolean" ? row.is_investable : undefined,
      is_cash_equivalent:
        typeof row.is_cash_equivalent === "boolean" ? row.is_cash_equivalent : undefined,
      is_sec_common_equity_ticker:
        typeof row.is_sec_common_equity_ticker === "boolean"
          ? row.is_sec_common_equity_ticker
          : undefined,
      symbol_kind: typeof row.symbol_kind === "string" ? row.symbol_kind : undefined,
      security_listing_status:
        typeof row.security_listing_status === "string"
          ? row.security_listing_status
          : undefined,
      analyze_eligible_reason:
        typeof row.analyze_eligible_reason === "string"
          ? row.analyze_eligible_reason
          : undefined,
    }))
    .filter((row) => row.symbol.length > 0 || row.name.length > 0);

  const nonCashHoldings = holdings.filter((row) => !isCashEquivalentRow(row));
  const investableHoldings = nonCashHoldings.filter((row) => TICKER_SYMBOL_REGEX.test(row.symbol));
  const excludedPositions = nonCashHoldings
    .filter((row) => !TICKER_SYMBOL_REGEX.test(row.symbol))
    .slice(0, 20)
    .map((row) => ({
      symbol: row.symbol || row.name || "UNKNOWN",
      reason: "missing_ticker_alias",
    }));
  const cashPositionsCount = holdings.length - nonCashHoldings.length;
  const tickerCoveragePct =
    nonCashHoldings.length > 0 ? investableHoldings.length / nonCashHoldings.length : 0;
  const sectorCoveragePct =
    nonCashHoldings.length > 0
      ? nonCashHoldings.filter((row) => Boolean(row.sector && row.sector.trim())).length / nonCashHoldings.length
      : 0;
  const gainLossCoveragePct =
    nonCashHoldings.length > 0
      ? nonCashHoldings.filter((row) => typeof row.unrealized_gain_loss_pct === "number").length /
        nonCashHoldings.length
      : 0;
  const topPositions = holdings
    .slice()
    .sort((a, b) => Math.abs(b.market_value || 0) - Math.abs(a.market_value || 0))
    .slice(0, 8)
    .map((row) => ({
      symbol: row.symbol || row.name || "UNKNOWN",
      market_value: row.market_value ?? null,
      position_side: row.position_side ?? null,
      sector: row.sector ?? null,
      asset_type: row.asset_type ?? null,
    }));
  const accountSummary =
    cached.account_summary && typeof cached.account_summary === "object" && !Array.isArray(cached.account_summary)
      ? (cached.account_summary as Record<string, unknown>)
      : {};
  const statementSignals = {
    investment_gain_loss: pickFirstNumber(accountSummary, [
      "investment_gain_loss",
      "total_change",
      "change_in_value",
    ]),
    total_income_period: pickFirstNumber(accountSummary, ["total_income_period"]),
    total_income_ytd: pickFirstNumber(accountSummary, ["total_income_ytd"]),
    total_fees: pickFirstNumber(accountSummary, ["total_fees"]),
    net_deposits_period: pickFirstNumber(accountSummary, [
      "net_deposits_period",
      "net_deposits_withdrawals",
    ]),
    net_deposits_ytd: pickFirstNumber(accountSummary, ["net_deposits_ytd"]),
  };

  return {
    holdings,
    holdings_count: holdings.length,
    account_summary: Object.keys(accountSummary).length > 0 ? accountSummary : undefined,
    asset_allocation:
      cached.asset_allocation && typeof cached.asset_allocation === "object"
        ? cached.asset_allocation
        : undefined,
    income_summary:
      cached.income_summary && typeof cached.income_summary === "object"
        ? cached.income_summary
        : undefined,
    realized_gain_loss:
      cached.realized_gain_loss && typeof cached.realized_gain_loss === "object"
        ? cached.realized_gain_loss
        : undefined,
    quality_report_v2:
      cached.quality_report_v2 && typeof cached.quality_report_v2 === "object"
        ? cached.quality_report_v2
        : undefined,
    total_value: toFiniteNumber(cached.total_value),
    cash_balance: toFiniteNumber(cached.cash_balance),
    debate_context: {
      portfolio_snapshot: {
        holdings_count: holdings.length,
        non_cash_holdings_count: nonCashHoldings.length,
        investable_holdings_count: investableHoldings.length,
        cash_positions_count: cashPositionsCount,
        total_value: toFiniteNumber(cached.total_value),
        cash_balance: toFiniteNumber(cached.cash_balance),
      },
      coverage: {
        ticker_coverage_pct: tickerCoveragePct,
        sector_coverage_pct: sectorCoveragePct,
        gain_loss_coverage_pct: gainLossCoveragePct,
      },
      statement_signals: statementSignals,
      eligible_symbols: investableHoldings
        .map((row) => row.symbol)
        .filter((symbol, index, arr) => symbol.length > 0 && arr.indexOf(symbol) === index)
        .slice(0, 20),
      top_positions: topPositions,
      excluded_positions: excludedPositions,
    },
  };
}

function hasRequiredDebateContext(context: Record<string, unknown> | null): boolean {
  if (!context) return false;
  const holdings = context.holdings;
  const debateContext = context.debate_context;
  if (!Array.isArray(holdings) || holdings.length === 0) return false;
  if (!debateContext || typeof debateContext !== "object" || Array.isArray(debateContext)) return false;
  const debate = debateContext as Record<string, unknown>;
  const snapshot = debate.portfolio_snapshot;
  const coverage = debate.coverage;
  const hasSnapshot =
    Boolean(snapshot) && typeof snapshot === "object" && !Array.isArray(snapshot);
  const hasCoverage =
    Boolean(coverage) && typeof coverage === "object" && !Array.isArray(coverage);
  return hasSnapshot && hasCoverage;
}

export async function prepareStockDebate({
  userId,
  vaultKey,
  vaultOwnerToken,
  riskProfile: riskProfileProp,
  portfolioContextOverride,
  portfolioSource,
}: {
  userId: string;
  vaultKey?: string;
  vaultOwnerToken: string;
  riskProfile?: string;
  portfolioContextOverride?: Record<string, unknown> | null;
  portfolioSource?: PortfolioSource;
}): Promise<{ context: Record<string, unknown> | null; effectiveRiskProfile: string }> {
  let context: Record<string, unknown> | null = null;
  let effectiveRiskProfile = riskProfileProp || "balanced";
  if (vaultKey) {
    try {
      const profile = await KaiProfileService.getProfile({
        userId,
        vaultKey,
        vaultOwnerToken,
      });
      effectiveRiskProfile =
        (profile.preferences.risk_profile as unknown as string | null) ||
        effectiveRiskProfile;
      context = {
        user_name: userId,
        preferences: {
          investment_horizon: profile.preferences.investment_horizon,
          investment_horizon_selected_at:
            profile.preferences.investment_horizon_selected_at,
          investment_horizon_anchor_at:
            profile.preferences.investment_horizon_anchor_at,
          drawdown_response: profile.preferences.drawdown_response,
          drawdown_response_selected_at:
            profile.preferences.drawdown_response_selected_at,
          volatility_preference: profile.preferences.volatility_preference,
          volatility_preference_selected_at:
            profile.preferences.volatility_preference_selected_at,
          risk_score: profile.preferences.risk_score,
          risk_profile: profile.preferences.risk_profile,
          risk_profile_selected_at:
            profile.preferences.risk_profile_selected_at,
        },
        financial_profile: profile,
      };
    } catch (profileError) {
      console.warn("[Finance debate] Failed to load Kai profile context:", profileError);
    }
  }

  let portfolioContext =
    portfolioContextOverride && typeof portfolioContextOverride === "object"
      ? portfolioContextOverride
      : extractDebatePortfolioContext(userId);
  if (!hasRequiredDebateContext(portfolioContext) && vaultKey) {
    try {
      const financialDomain =
        (
          await PkmDomainResourceService.getStaleFirst({
            userId,
            domain: "financial",
            vaultKey,
            vaultOwnerToken,
            backgroundRefresh: false,
          })
        )?.data ??
        (await PersonalKnowledgeModelService.loadDomainData({
          userId,
          domain: "financial",
          vaultKey,
          vaultOwnerToken,
        }));
      const hydratedContext =
        extractDebatePortfolioContext(userId, financialDomain ?? undefined) ??
        portfolioContext;
      portfolioContext = hydratedContext;
    } catch (blobError) {
      console.warn(
        "[Finance debate] Failed to hydrate debate context from the financial PKM domain:",
        blobError
      );
    }
  }

  if (portfolioContext) {
    const sourceTag =
      portfolioSource ||
      (portfolioContext.source_metadata &&
      typeof portfolioContext.source_metadata === "object" &&
      typeof (portfolioContext.source_metadata as Record<string, unknown>).source_type === "string"
        ? ((portfolioContext.source_metadata as Record<string, unknown>).source_type as PortfolioSource)
        : undefined);
    context = {
      ...(context || {}),
      ...portfolioContext,
      portfolio_source: sourceTag,
    };
  }

  return { context, effectiveRiskProfile };
}
