/**
 * Types for the zero-knowledge Plaid lane.
 *
 * Two halves:
 * 1. The wire contract of the stateless passthrough at `/api/kai/plaid/vault`.
 *    The server keeps nothing; the person's access token lives sealed in their
 *    vault and is sent per call.
 * 2. The records written into the person's encrypted `financial` memory, in
 *    three tiers:
 *    - Tier A (private raw records): connections, accounts, holdings,
 *      securities, transactions.
 *    - Tier B (private derived facts): `derived_v1`, recomputed from Tier A.
 *    - Tier C (shareable summary): `summary`, bands, percentages and counts
 *      only.
 */

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

export type PlaidVaultPlatform = "web" | "ios" | "android";

export interface PlaidVaultLinkTokenRequest {
  platform: PlaidVaultPlatform;
  redirect_uri?: string | null;
}

export interface PlaidVaultLinkTokenResponse {
  link_token: string;
  expiration: string;
}

export interface PlaidVaultInstitution {
  id: string;
  name: string;
}

export interface PlaidVaultExchangeResponse {
  access_token: string;
  item_id: string;
  institution: PlaidVaultInstitution | null;
  products: string[];
  consented_products?: string[];
}

export interface PlaidBalances {
  available?: number | null;
  current?: number | null;
  limit?: number | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  persistent_account_id?: string | null;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: PlaidBalances;
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price?: number | null;
  institution_price_as_of?: string | null;
  institution_value?: number | null;
  cost_basis?: number | null;
  iso_currency_code?: string | null;
}

export interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  name?: string | null;
  type?: string | null;
  subtype?: string | null;
  cusip?: string | null;
  isin?: string | null;
  close_price?: number | null;
  close_price_as_of?: string | null;
  is_cash_equivalent?: boolean | null;
  sector?: string | null;
  industry?: string | null;
}

export interface PlaidPersonalFinanceCategory {
  primary: string;
  detailed?: string | null;
  confidence_level?: string | null;
}

export interface PlaidLocation {
  address?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  store_number?: string | null;
}

export interface PlaidCounterparty {
  name?: string | null;
  type?: string | null;
  entity_id?: string | null;
  website?: string | null;
  logo_url?: string | null;
}

export interface PlaidTx {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  merchant_entity_id?: string | null;
  pending?: boolean;
  pending_transaction_id?: string | null;
  payment_channel?: string | null;
  personal_finance_category?: PlaidPersonalFinanceCategory | null;
  category?: string[] | null;
  location?: PlaidLocation | null;
  counterparties?: PlaidCounterparty[] | null;
  logo_url?: string | null;
  website?: string | null;
}

export interface PlaidUnavailable {
  unavailable: string;
}

export interface PlaidInvestmentsSnapshot {
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

export interface PlaidTransactionsSnapshot {
  added: PlaidTx[];
  modified: PlaidTx[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  pages: number;
}

export interface PlaidItemError {
  code: string;
  message: string;
}

export interface PlaidSnapshotItem {
  item_id: string;
  institution_id: string | null;
  products: string[];
  consented_products: string[];
  error: PlaidItemError | null;
}

export interface PlaidVaultSnapshotRequest {
  access_token: string;
  transactions_cursor?: string | null;
}

export interface PlaidVaultSnapshot {
  item: PlaidSnapshotItem;
  accounts: PlaidAccount[];
  investments: PlaidInvestmentsSnapshot | PlaidUnavailable;
  transactions: PlaidTransactionsSnapshot | PlaidUnavailable;
}

export interface PlaidVaultRemoveResponse {
  removed: true;
}

export function isUnavailable(value: unknown): value is PlaidUnavailable {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as PlaidUnavailable).unavailable === "string"
  );
}

// ---------------------------------------------------------------------------
// Memory records (financial domain)
// ---------------------------------------------------------------------------

export type ConnectionStatus = "active" | "needs_relink";

/** Tier A: `financial.connections_v1[item_id]`. Holds the sealed access token. */
export interface ConnectionRecord {
  access_token: string;
  institution_id: string | null;
  institution_name: string | null;
  products: string[];
  linked_at: string;
  transactions_cursor: string | null;
  last_refreshed_at: string | null;
  status: ConnectionStatus;
}

export interface AccountBalancesRecord {
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code: string | null;
}

/** Tier A: `financial.accounts_v1[`${item_id}:${account_id}`]`. */
export interface AccountRecord {
  account_id: string;
  persistent_account_id: string | null;
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: AccountBalancesRecord;
  /** Key of the canonical account when this is the same real account linked again. */
  duplicate_of: string | null;
}

/** Tier A: `financial.holdings_v1[`${account_id}:${security_id}`]`. */
export interface HoldingRecord {
  item_id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number | null;
  institution_price_as_of: string | null;
  institution_value: number;
  cost_basis: number | null;
  iso_currency_code: string | null;
}

/** Tier A: `financial.securities_v1[security_id]`. CUSIP stays private here. */
export interface SecurityRecord {
  security_id: string;
  ticker: string | null;
  name: string | null;
  type: string | null;
  subtype: string | null;
  cusip: string | null;
  is_cash_equivalent: boolean;
  close_price: number | null;
  sector: string | null;
  industry: string | null;
}

export interface TransactionLocationRecord {
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface TransactionCounterpartyRecord {
  name: string | null;
  type: string | null;
}

/** Tier A: `financial.transactions_v1[transaction_id]`. */
export interface TransactionRecord {
  transaction_id: string;
  item_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string | null;
  merchant_name: string | null;
  pending: boolean;
  payment_channel: string | null;
  category_primary: string | null;
  category_detailed: string | null;
  location: TransactionLocationRecord | null;
  counterparties: TransactionCounterpartyRecord[] | null;
  /** True once the 90-day retention rule replaced merchant detail with the category. */
  reduced: boolean;
}

/** Every Tier B fact carries where it came from and when. */
export interface DerivedFact<T> {
  value: T;
  computed_at: string;
  source_item_ids: string[];
}

export interface MonthlyCashFlow {
  month: string;
  income: number;
  spend: number;
  net: number;
}

export type RecurringCadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

export interface RecurringBill {
  label: string;
  category: string | null;
  cadence: RecurringCadence;
  typical_amount: number;
  occurrences: number;
  last_date: string;
}

export interface IncomeStability {
  coefficient_of_variation: number | null;
  months_observed: number;
  label: "stable" | "variable" | "unknown";
}

export type CashFlowTrend = "positive" | "flat" | "negative";

/** Tier B: `financial.derived_v1`. Private. */
export interface DerivedFactsV1 {
  schema: "plaid-derived-v1";
  computed_at: string;
  total_assets: DerivedFact<number>;
  total_liabilities: DerivedFact<number>;
  net_worth: DerivedFact<number>;
  net_worth_band: DerivedFact<string>;
  liquid_cash: DerivedFact<number>;
  investable_assets: DerivedFact<number>;
  allocation_pct: DerivedFact<Record<string, number>>;
  monthly_cash_flow: DerivedFact<MonthlyCashFlow[]>;
  cash_flow_trend: DerivedFact<CashFlowTrend>;
  recurring_bills: DerivedFact<RecurringBill[]>;
  income_stability: DerivedFact<IncomeStability>;
  debt_to_asset_ratio: DerivedFact<number | null>;
  account_type_counts: DerivedFact<Record<string, number>>;
}

/** Tier C: `financial.summary`. Shareable: bands, percentages and counts only. */
export interface ShareableSummaryV1 {
  schema: "plaid-summary-v1";
  net_worth_band: string;
  liquid_cash_band: string;
  investable_assets_band: string;
  allocation_pct: Record<string, number>;
  cash_flow_trend: CashFlowTrend;
  income_stability: IncomeStability["label"];
  debt_to_asset_pct: number | null;
  account_type_counts: Record<string, number>;
  account_count: number;
  institution_count: number;
  connection_count: number;
  needs_relink_count: number;
  recurring_bill_count: number;
  last_updated: string;
}

/** The part of the financial domain this lane owns. Other keys pass through untouched. */
export interface PlaidVaultMemory {
  connections_v1?: Record<string, ConnectionRecord>;
  accounts_v1?: Record<string, AccountRecord>;
  holdings_v1?: Record<string, HoldingRecord>;
  securities_v1?: Record<string, SecurityRecord>;
  transactions_v1?: Record<string, TransactionRecord>;
  derived_v1?: DerivedFactsV1;
  summary?: ShareableSummaryV1;
}

export type FinancialDomain = Record<string, unknown> & PlaidVaultMemory;

export interface ConnectionLinkInput {
  item_id: string;
  access_token: string;
  institution: PlaidVaultInstitution | null;
  products: string[];
}
