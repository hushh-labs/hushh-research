/** Wire contract of the stateless Plaid vault passthrough. */

export type PlaidVaultPlatform = "web" | "ios" | "android";

export interface PlaidVaultLinkTokenRequest {
  platform: PlaidVaultPlatform;
  redirect_uri?: string | null;
  /** Local native proof only; never selects a provider environment. */
  sandbox_proof?: boolean;
  origin_surface?: "profile_nws" | "agentone_chat";
  additional_product?: "investments" | "liabilities";
  select_accounts?: boolean;
  /** Update mode (relink): the sealed token of the Item being repaired. */
  access_token?: string | null;
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
  holder_category?: string | null;
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
  unofficial_currency_code?: string | null;
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
  unofficial_currency_code?: string | null;
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
  /** More pages remain after this snapshot's page cap; follow with next_cursor. */
  has_more?: boolean;
  pages: number;
  transactions_update_status?: string;
}

export interface PlaidItemError {
  code: string;
  message: string;
}

export interface PlaidSnapshotItem {
  /** Null when Plaid refused the sealed token before naming the Item. */
  item_id: string | null;
  institution_id: string | null;
  products: string[];
  consented_products: string[];
  nws_debt_details_available?: boolean;
  nws_investments_available?: boolean;
  error: PlaidItemError | null;
}

export interface PlaidVaultSnapshotRequest {
  access_token: string;
  include_country_on_file?: boolean;
  transactions_cursor?: string | null;
  transactions_continuation?: boolean;
}

export interface PlaidVaultSnapshot {
  item: PlaidSnapshotItem;
  /** On a successful first page when requested. Null means unavailable. */
  country_on_file?: string | null;
  accounts: PlaidAccount[];
  investments: PlaidInvestmentsSnapshot | PlaidUnavailable;
  transactions: PlaidTransactionsSnapshot | PlaidUnavailable;
  liabilities?: {
    credit: { account_id: string; aprs: { apr_percentage: number | null }[] }[];
  };
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
