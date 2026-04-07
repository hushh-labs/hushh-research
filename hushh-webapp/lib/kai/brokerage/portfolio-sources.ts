"use client";

import type { PortfolioData } from "@/components/kai/types/portfolio";

export type PortfolioSource = "statement" | "plaid";
export type PortfolioSyncStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "action_required"
  | "stale";

export interface PortfolioSourceMetadata {
  source_type?: PortfolioSource | string;
  source_label?: string;
  is_editable?: boolean;
  sync_status?: PortfolioSyncStatus | string;
  last_synced_at?: string | null;
  institution_names?: string[];
  item_count?: number;
  account_count?: number;
  requires_explicit_source_selection_for_analysis?: boolean;
}

export interface PortfolioFreshness {
  syncStatus: PortfolioSyncStatus | string;
  lastSyncedAt: string | null;
  institutionNames: string[];
  itemCount: number;
  accountCount: number;
}

export interface StatementSnapshotOption {
  id: string;
  label: string;
  brokerage?: string | null;
  statementPeriodEnd?: string | null;
  importedAt?: string | null;
}

export interface PlaidRefreshRun {
  run_id: string;
  item_id: string;
  status: string;
  trigger_source?: string | null;
  refresh_method?: string | null;
  fallback_reason?: string | null;
  requested_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  result_summary_json?: Record<string, unknown>;
}

export interface PlaidAccountSummary {
  account_id: string;
  persistent_account_id?: string | null;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: {
    available?: number | null;
    current?: number | null;
    iso_currency_code?: string | null;
    limit?: number | null;
  };
  institution_id?: string | null;
  institution_name?: string | null;
  item_id: string;
}

export interface PlaidItemSummary {
  item_id: string;
  institution_id?: string | null;
  institution_name?: string | null;
  status: string;
  sync_status: PortfolioSyncStatus | string;
  last_synced_at?: string | null;
  last_refresh_requested_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  last_webhook_type?: string | null;
  last_webhook_code?: string | null;
  summary?: Record<string, unknown>;
  accounts?: PlaidAccountSummary[];
  portfolio_data?: PortfolioData | null;
  latest_refresh_run?: PlaidRefreshRun | null;
}

export interface PlaidAggregateStatus {
  item_count: number;
  account_count: number;
  holdings_count: number;
  institution_names: string[];
  last_synced_at?: string | null;
  sync_status: PortfolioSyncStatus | string;
  portfolio_data?: PortfolioData | null;
  projection_stale?: boolean;
  projected_at?: string | null;
}

export interface PlaidPortfolioStatusResponse {
  configured: boolean;
  environment?: string;
  webhook_configured?: boolean;
  webhook_url?: string | null;
  user_id: string;
  source_preference: PortfolioSource | string;
  items: PlaidItemSummary[];
  aggregate: PlaidAggregateStatus;
}

export interface PlaidFundingTransferRef {
  transfer_id: string;
  authorization_id?: string | null;
  relationship_id?: string | null;
  status?: string | null;
  user_facing_status?: string | null;
  amount?: string | null;
  direction?: string | null;
  funding_account_id?: string | null;
  brokerage_item_id?: string | null;
  brokerage_account_id?: string | null;
  alpaca_account_id?: string | null;
  idempotency_key?: string | null;
  created_at?: string | null;
  requested_at?: string | null;
  completed_at?: string | null;
  failure_reason_code?: string | null;
  failure_reason_message?: string | null;
}

export interface PlaidFundingBrokerageAccountSummary {
  alpaca_account_id?: string | null;
  status?: string | null;
  is_default?: boolean;
}

export interface PlaidFundingAccountSummary extends PlaidAccountSummary {
  is_selected_funding_account?: boolean;
  is_default?: boolean;
}

export interface PlaidFundingRelationshipSummary {
  relationship_id?: string | null;
  alpaca_account_id?: string | null;
  account_id?: string | null;
  status?: string | null;
  status_reason_code?: string | null;
  status_reason_message?: string | null;
  updated_at?: string | null;
}

export interface PlaidFundingItemSummary {
  item_id: string;
  institution_id?: string | null;
  institution_name?: string | null;
  status: string;
  sync_status: PortfolioSyncStatus | string;
  last_synced_at?: string | null;
  selected_funding_account_id?: string | null;
  transactions_cursor?: string | null;
  accounts: PlaidFundingAccountSummary[];
  relationships?: PlaidFundingRelationshipSummary[];
  transfers: PlaidFundingTransferRef[];
}

export interface PlaidFundingStatusResponse {
  configured: boolean;
  environment?: string;
  webhook_configured?: boolean;
  webhook_url?: string | null;
  user_id: string;
  items: PlaidFundingItemSummary[];
  brokerage_accounts?: PlaidFundingBrokerageAccountSummary[];
  latest_transfers: PlaidFundingTransferRef[];
  aggregate: {
    item_count: number;
    account_count: number;
    relationship_count?: number;
    institution_names: string[];
    last_synced_at?: string | null;
  };
}

export interface PlaidTransferPayload {
  transfer_id?: string | null;
  authorization_id?: string | null;
  status?: string | null;
  type?: string | null;
  network?: string | null;
  ach_class?: string | null;
  description?: string | null;
  amount?: string | null;
  iso_currency_code?: string | null;
  failure_reason?: unknown;
  created_at?: string | null;
  raw?: Record<string, unknown>;
}

export interface NormalizedPortfolioTransaction {
  trade_date?: string;
  date?: string;
  settle_date?: string;
  type: string;
  symbol: string;
  description?: string;
  quantity?: number;
  price?: number;
  amount: number;
  cost_basis?: number;
  realized_gain_loss?: number;
  fees?: number;
}

function normalizeSymbol(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeDateValue(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text.length > 0 ? text : undefined;
}

function sortDateValue(row: { trade_date?: string; date?: string }): number {
  const value = row.trade_date || row.date;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function hasPortfolioHoldings(
  portfolio: PortfolioData | null | undefined
): portfolio is PortfolioData & { holdings: NonNullable<PortfolioData["holdings"]> } {
  return Boolean(
    portfolio &&
      Array.isArray(portfolio.holdings) &&
      portfolio.holdings.length > 0
  );
}

export function normalizePortfolioTransactions(
  portfolio: PortfolioData | null | undefined
): NormalizedPortfolioTransaction[] {
  const sourceRows = Array.isArray(portfolio?.activity_and_transactions)
    ? portfolio?.activity_and_transactions
    : Array.isArray(portfolio?.transactions)
      ? portfolio?.transactions
      : [];
  const normalized: NormalizedPortfolioTransaction[] = [];

  for (const row of sourceRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const symbol = String(
      record.symbol ||
        record.ticker_symbol ||
        record.security_symbol ||
        record.security_name ||
        record.name ||
        ""
    )
      .trim()
      .toUpperCase();
    const amount = toNumber(
      record.amount ?? record.net_amount ?? record.market_value ?? record.value
    );
    if (!symbol || amount === 0) continue;

    normalized.push({
      trade_date: normalizeDateValue(
        record.trade_date ?? record.tradeDate ?? record.execution_date
      ),
      date: normalizeDateValue(record.date ?? record.transaction_date),
      settle_date: normalizeDateValue(record.settle_date ?? record.settlement_date),
      type: String(
        record.type || record.transaction_type || record.subtype || "TRANSFER"
      )
        .trim()
        .toUpperCase(),
      symbol,
      description: String(
        record.description || record.security_name || record.name || ""
      ).trim() || undefined,
      quantity: toNumber(record.quantity ?? record.units),
      price: toNumber(record.price ?? record.unit_price),
      amount,
      cost_basis: toNumber(record.cost_basis),
      realized_gain_loss: toNumber(
        record.realized_gain_loss ?? record.realized_gain_loss_amount
      ),
      fees: toNumber(record.fees),
    });
  }

  return normalized.sort((left, right) => sortDateValue(right) - sortDateValue(left));
}

export function resolveAvailableSources(params: {
  statementPortfolio?: PortfolioData | null;
  plaidPortfolio?: PortfolioData | null;
}): PortfolioSource[] {
  const sources: PortfolioSource[] = [];
  if (hasPortfolioHoldings(params.statementPortfolio)) {
    sources.push("statement");
  }
  if (hasPortfolioHoldings(params.plaidPortfolio)) {
    sources.push("plaid");
  }
  return sources;
}

export function resolvePortfolioFreshness(
  plaidStatus: PlaidPortfolioStatusResponse | null | undefined
): PortfolioFreshness | null {
  if (!plaidStatus) return null;
  return {
    syncStatus: plaidStatus.aggregate?.sync_status || "idle",
    lastSyncedAt: plaidStatus.aggregate?.last_synced_at || null,
    institutionNames: plaidStatus.aggregate?.institution_names || [],
    itemCount: Number(plaidStatus.aggregate?.item_count || 0),
    accountCount: Number(plaidStatus.aggregate?.account_count || 0),
  };
}

function isCashEquivalentRow(row: {
  symbol?: string;
  name?: string;
  asset_type?: string;
  is_cash_equivalent?: boolean;
}): boolean {
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

export function buildDebateContextFromPortfolio(
  portfolio: PortfolioData | null | undefined
): Record<string, unknown> | null {
  if (!hasPortfolioHoldings(portfolio)) return null;

  const holdings = portfolio.holdings
    .slice(0, 30)
    .map((row) => ({
      symbol: normalizeSymbol(row.symbol),
      name: String(row.name || "").trim(),
      quantity: toNumber(row.quantity),
      market_value: toNumber(row.market_value),
      position_side:
        typeof row.position_side === "string" &&
        ["long", "short", "liability"].includes(row.position_side.trim().toLowerCase())
          ? row.position_side.trim().toLowerCase()
          : undefined,
      is_short_position: row.is_short_position,
      is_liability_position: row.is_liability_position,
      unrealized_gain_loss_pct:
        typeof row.unrealized_gain_loss_pct === "number"
          ? row.unrealized_gain_loss_pct
          : undefined,
      sector: typeof row.sector === "string" ? row.sector : undefined,
      asset_type: typeof row.asset_type === "string" ? row.asset_type : undefined,
      is_investable: row.is_investable,
      is_cash_equivalent: row.is_cash_equivalent,
      is_sec_common_equity_ticker: row.is_sec_common_equity_ticker,
      symbol_kind: row.symbol_kind,
      security_listing_status: row.security_listing_status,
      analyze_eligible_reason: row.analyze_eligible_reason,
    }))
    .filter((row) => row.symbol.length > 0 || row.name.length > 0);

  const nonCashHoldings = holdings.filter((row) => !isCashEquivalentRow(row));
  const investableHoldings = nonCashHoldings.filter(
    (row) => /^[A-Z][A-Z0-9.\-]{0,5}$/.test(row.symbol) && row.is_investable !== false
  );
  const excludedPositions = nonCashHoldings
    .filter((row) => !/^[A-Z][A-Z0-9.\-]{0,5}$/.test(row.symbol))
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
      ? nonCashHoldings.filter((row) => Boolean(row.sector && row.sector.trim())).length /
        nonCashHoldings.length
      : 0;
  const gainLossCoveragePct =
    nonCashHoldings.length > 0
      ? nonCashHoldings.filter((row) => typeof row.unrealized_gain_loss_pct === "number").length /
        nonCashHoldings.length
      : 0;
  const topPositions = [...holdings]
    .sort((left, right) => Math.abs(right.market_value || 0) - Math.abs(left.market_value || 0))
    .slice(0, 8)
    .map((row) => ({
      symbol: row.symbol || row.name || "UNKNOWN",
      market_value: row.market_value ?? null,
      position_side: row.position_side ?? null,
      sector: row.sector ?? null,
      asset_type: row.asset_type ?? null,
    }));
  const transactions = normalizePortfolioTransactions(portfolio).slice(0, 20);
  const transactionSummary = transactions.reduce(
    (acc, row) => {
      const normalizedType = row.type.toUpperCase();
      acc.total_count += 1;
      acc.total_amount += Math.abs(row.amount);
      if (normalizedType.includes("BUY")) acc.buy_count += 1;
      if (normalizedType.includes("SELL")) acc.sell_count += 1;
      if (normalizedType.includes("DIVIDEND")) acc.dividend_count += 1;
      if (typeof row.fees === "number" && Number.isFinite(row.fees)) {
        acc.total_fees += row.fees;
      }
      return acc;
    },
    {
      total_count: 0,
      total_amount: 0,
      buy_count: 0,
      sell_count: 0,
      dividend_count: 0,
      total_fees: 0,
    }
  );

  return {
    holdings,
    holdings_count: holdings.length,
    account_summary:
      portfolio.account_summary && typeof portfolio.account_summary === "object"
        ? portfolio.account_summary
        : undefined,
    asset_allocation:
      portfolio.asset_allocation && typeof portfolio.asset_allocation === "object"
        ? portfolio.asset_allocation
        : undefined,
    income_summary:
      portfolio.income_summary && typeof portfolio.income_summary === "object"
        ? portfolio.income_summary
        : undefined,
    realized_gain_loss:
      portfolio.realized_gain_loss && typeof portfolio.realized_gain_loss === "object"
        ? portfolio.realized_gain_loss
        : undefined,
    quality_report_v2:
      portfolio.quality_report_v2 && typeof portfolio.quality_report_v2 === "object"
        ? portfolio.quality_report_v2
        : undefined,
    total_value: toNumber(portfolio.total_value),
    cash_balance: toNumber(portfolio.cash_balance),
    source_metadata:
      portfolio.source_metadata && typeof portfolio.source_metadata === "object"
        ? portfolio.source_metadata
        : undefined,
    recent_transactions: transactions,
    debate_context: {
      portfolio_snapshot: {
        holdings_count: holdings.length,
        non_cash_holdings_count: nonCashHoldings.length,
        investable_holdings_count: investableHoldings.length,
        cash_positions_count: cashPositionsCount,
        total_value: toNumber(portfolio.total_value),
        cash_balance: toNumber(portfolio.cash_balance),
        source_type: portfolio.source_metadata?.source_type || "statement",
      },
      coverage: {
        ticker_coverage_pct: tickerCoveragePct,
        sector_coverage_pct: sectorCoveragePct,
        gain_loss_coverage_pct: gainLossCoveragePct,
      },
      statement_signals: {
        investment_gain_loss: toNumber(portfolio.account_summary?.investment_gain_loss),
        total_income_period: toNumber(portfolio.account_summary?.total_income_period),
        total_income_ytd: toNumber(portfolio.account_summary?.total_income_ytd),
        total_fees: toNumber(portfolio.account_summary?.total_fees),
        net_deposits_period: toNumber(portfolio.account_summary?.net_deposits_period),
        net_deposits_ytd: toNumber(portfolio.account_summary?.net_deposits_ytd),
      },
      eligible_symbols: investableHoldings
        .map((row) => row.symbol)
        .filter((symbol, index, arr) => symbol.length > 0 && arr.indexOf(symbol) === index)
        .slice(0, 20),
      top_positions: topPositions,
      excluded_positions: excludedPositions,
      transaction_summary: {
        ...transactionSummary,
        total_amount: Number(transactionSummary.total_amount.toFixed(2)),
        total_fees: Number(transactionSummary.total_fees.toFixed(2)),
      },
    },
  };
}
