export interface Holding {
  symbol: string;
  symbol_cusip?: string;
  identifier_type?: "ticker" | "cusip" | "derived";
  name: string;
  quantity: number;
  price: number;
  market_value: number;
  weight_pct?: number;
  cost_basis?: number;
  unrealized_gain_loss?: number;
  unrealized_gain_loss_pct?: number;
  acquisition_date?: string;
  estimated_annual_income?: number;
  est_yield?: number;
  asset_class?: string;
  sector?: string;
  asset_type?: string;
  instrument_kind?: string;
  is_cash_equivalent?: boolean;
  is_investable?: boolean;
  analyze_eligible?: boolean;
  analyze_eligible_reason?: string;
  debate_eligible?: boolean;
  optimize_eligible?: boolean;
  symbol_source?: string;
  symbol_kind?: string;
  security_listing_status?: string;
  is_sec_common_equity_ticker?: boolean;
  is_margin?: boolean;
  is_short?: boolean;
  position_side?: "long" | "short" | "liability";
  is_short_position?: boolean;
  is_liability_position?: boolean;
  confidence?: number;
  provenance?: Record<string, unknown>;
  source_type?: string;
  source_id?: string;
  item_id?: string;
  account_id?: string;
  account_name?: string;
  account_mask?: string;
  account_subtype?: string;
  persistent_account_id?: string;
  institution_id?: string;
  institution_name?: string;
  last_synced_at?: string;
  institution_price_as_of?: string;
  is_editable?: boolean;
  sync_status?: string;
  security_id?: string;
  proxy_security_id?: string;
  industry?: string;
}

export interface AccountSummary {
  beginning_value?: number;
  ending_value: number;
  change_in_value?: number;
  cash_balance?: number;
  equities_value?: number;
  total_change?: number;
  net_deposits_withdrawals?: number;
  net_deposits_period?: number;
  net_deposits_ytd?: number;
  investment_gain_loss?: number;
  total_income_period?: number;
  total_income_ytd?: number;
  total_fees?: number;
}

export interface PortfolioData {
  account_info?: {
    account_number?: string;
    brokerage_name?: string;
    institution_name?: string;
    statement_period?: string;
    statement_period_start?: string;
    statement_period_end?: string;
    account_holder?: string;
    account_type?: string;
  };
  account_summary?: AccountSummary;
  holdings?: Holding[];
  transactions?: Array<Record<string, unknown>>;
  activity_and_transactions?: Array<Record<string, unknown>>;
  asset_allocation?:
    | {
        cash_percent?: number;
        cash_pct?: number;
        equities_percent?: number;
        equities_pct?: number;
        bonds_percent?: number;
        bonds_pct?: number;
        other_percent?: number;
        other_pct?: number;
        cash_value?: number;
        equities_value?: number;
        bonds_value?: number;
        other_value?: number;
      }
    | Array<{ category: string; market_value: number; percentage: number }>;
  income_summary?: {
    dividends_taxable?: number;
    interest_income?: number;
    total_income?: number;
    dividends?: number;
    interest?: number;
    total?: number;
  };
  realized_gain_loss?: {
    short_term?: number;
    short_term_gain?: number;
    short_term_loss?: number;
    long_term?: number;
    long_term_gain?: number;
    long_term_loss?: number;
    total?: number;
    net_realized?: number;
    net_short_term?: number;
    net_long_term?: number;
  };
  historical_values?: Array<Record<string, unknown>>;
  cash_flow?: Record<string, unknown>;
  cash_management?: Record<string, unknown>;
  cash_balance?: number;
  total_value?: number;
  ytd_metrics?: Record<string, unknown>;
  ytd_summary?: Record<string, unknown>;
  total_fees?: number;
  projections_and_mrd?: Record<string, unknown>;
  legal_and_disclosures?: string[];
  quality_report_v2?: {
    schema_version?: number;
    raw_count?: number;
    validated_count?: number;
    aggregated_count?: number;
    holdings_count?: number;
    investable_positions_count?: number;
    cash_positions_count?: number;
    allocation_coverage_pct?: number;
    symbol_trust_coverage_pct?: number;
    parser_quality_score?: number;
    quality_gate?: Record<string, unknown>;
    dropped_reasons?: Record<string, number>;
    diagnostics?: Record<string, unknown>;
  };
  raw_extract_v2?: Record<string, unknown>;
  analytics_v2?: {
    allocation_mix?: Array<Record<string, unknown>>;
    sector_exposure?: Array<Record<string, unknown>>;
    concentration?: Array<Record<string, unknown>>;
    gain_loss_distribution?: Array<Record<string, unknown>>;
    income_breakdown?: Record<string, unknown>;
    reconciliation_metrics?: Record<string, unknown>;
    quality_metrics?: Record<string, unknown>;
    debate_readiness?: Record<string, unknown>;
    optimize_signals?: Record<string, unknown>;
  };
  source_metadata?: {
    source_type?: string;
    source_label?: string;
    is_editable?: boolean;
    sync_status?: string;
    last_synced_at?: string | null;
    institution_names?: string[];
    item_count?: number;
    account_count?: number;
    requires_explicit_source_selection_for_analysis?: boolean;
  };
  parse_fallback?: boolean;
}
