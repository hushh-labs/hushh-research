/**
 * The readable view of a person's linked accounts: `financial.linked_accounts`.
 *
 * The sealed records (`accounts_v1` and friends) are keyed by Plaid's ids and
 * typed with Plaid's codes, because that is what syncing needs. Shown to a
 * person they read as a flat list of random strings ("Accounts V1 > BxBXxLj1m4
 * HMXBm9WZZmCWVbPjX16EHwv99vp") with every re-link repeated. This view is the
 * same information the way a person thinks about it:
 *
 *   Finance > Bank accounts > Tartan Bank > Plaid Checking ••0000 > Current balance
 *
 * Rules the shape keeps:
 * - Lists, never id-keyed maps: an entry is named by `name`, so no Plaid id is
 *   ever a path segment, and the manifest walk collapses lists to `_items`.
 * - Plain words for Plaid's account and security codes.
 * - The same real account linked twice appears once (`duplicate_of`).
 * - Pure and deterministic: rebuilt from the records on every change, so it
 *   cannot drift from them and replaying a snapshot stays a no-op.
 */

import {
  LINKED_ACCOUNTS_SCHEMA_VERSION,
  type AccountRecord,
  type ConnectionRecord,
  type DerivedFactsV1,
  type HoldingRecord,
  type LinkedAccountView,
  type LinkedAccountsViewV1,
  type LinkedHoldingView,
  type LinkedInstitutionView,
  type LinkedTransactionView,
  type SecurityRecord,
  type TransactionRecord,
} from "@/lib/kai/plaid-vault/types";

type Category = "bank_accounts" | "investments" | "credit_cards" | "loans" | "other_accounts";

const CATEGORY_ORDER: readonly Category[] = [
  "bank_accounts",
  "investments",
  "credit_cards",
  "loans",
  "other_accounts",
];

/** Plaid account subtypes in the words a person uses. */
const SUBTYPE_WORDS: Readonly<Record<string, string>> = {
  checking: "Checking",
  savings: "Savings",
  cd: "CD",
  "money market": "Money market",
  hsa: "HSA",
  "cash management": "Cash management",
  prepaid: "Prepaid card",
  paypal: "PayPal",
  ebt: "EBT",
  "credit card": "Credit card",
  auto: "Auto loan",
  student: "Student loan",
  mortgage: "Mortgage",
  "home equity": "Home equity line",
  "line of credit": "Line of credit",
  business: "Business loan",
  commercial: "Commercial loan",
  construction: "Construction loan",
  consumer: "Personal loan",
  loan: "Loan",
  "401a": "401(a)",
  "401k": "401(k)",
  "403b": "403(b)",
  "457b": "457(b)",
  "529": "529 plan",
  brokerage: "Brokerage",
  "non-taxable brokerage account": "Brokerage (non-taxable)",
  ira: "IRA",
  roth: "Roth IRA",
  "roth 401k": "Roth 401(k)",
  "sep ira": "SEP IRA",
  "simple ira": "SIMPLE IRA",
  pension: "Pension",
  retirement: "Retirement",
  "profit sharing plan": "Profit sharing plan",
  "stock plan": "Stock plan",
  "mutual fund": "Mutual fund",
  "crypto exchange": "Crypto",
  "education savings account": "Education savings",
  "health reimbursement arrangement": "Health reimbursement",
  "fixed annuity": "Fixed annuity",
  "variable annuity": "Variable annuity",
  "life insurance": "Life insurance",
  trust: "Trust",
  ugma: "UGMA",
  utma: "UTMA",
  isa: "ISA",
  "cash isa": "Cash ISA",
  sipp: "SIPP",
  tfsa: "TFSA",
  rrsp: "RRSP",
  gic: "GIC",
  keogh: "Keogh",
};

/** Used when Plaid gives a type but no subtype. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  depository: "Bank account",
  credit: "Credit card",
  loan: "Loan",
  investment: "Investment account",
  brokerage: "Brokerage",
  other: "Account",
};

const SECURITY_KIND_WORDS: Readonly<Record<string, string>> = {
  equity: "Stock",
  etf: "ETF",
  "mutual fund": "Mutual fund",
  "fixed income": "Bond",
  derivative: "Option",
  cash: "Cash",
  cryptocurrency: "Crypto",
  loan: "Loan",
  other: "Other",
};

const MASK_PREFIX = "••";

function sentenceCase(text: string): string {
  const words = text.replace(/[_\s]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function accountTypeWords(type: string | null | undefined, subtype: string | null | undefined): string {
  const sub = lower(subtype);
  if (sub) return SUBTYPE_WORDS[sub] ?? sentenceCase(sub);
  const kind = lower(type);
  return TYPE_WORDS[kind] ?? (kind ? sentenceCase(kind) : "Account");
}

export function securityKindWords(security: SecurityRecord | undefined): string {
  if (!security) return "Other";
  if (security.is_cash_equivalent) return "Cash";
  const kind = lower(security.type);
  return SECURITY_KIND_WORDS[kind] ?? (kind ? sentenceCase(kind) : "Other");
}

function categoryFor(type: string): Category {
  const kind = lower(type);
  if (kind === "depository") return "bank_accounts";
  if (kind === "investment" || kind === "brokerage") return "investments";
  if (kind === "credit") return "credit_cards";
  if (kind === "loan") return "loans";
  return "other_accounts";
}

function categoryWords(code: string | null): string {
  return code ? sentenceCase(code) || "Uncategorized" : "Uncategorized";
}

function finite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Give repeated names a " (2)", " (3)" suffix, in the order given. */
function disambiguate<T extends { name: string }>(entries: T[]): T[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, count);
    return count === 1 ? entry : { ...entry, name: `${entry.name} (${count})` };
  });
}

export function accountDisplayName(account: Pick<AccountRecord, "name" | "mask">): string {
  const name = account.name?.trim() || "Account";
  const mask = account.mask?.trim();
  return mask ? `${name} ${MASK_PREFIX}${mask}` : name;
}

function holdingsView(
  account: AccountRecord,
  holdings: HoldingRecord[],
  securities: Map<string, SecurityRecord>,
): LinkedHoldingView[] {
  return holdings
    .filter((holding) => holding.item_id === account.item_id && holding.account_id === account.account_id)
    .map((holding) => {
      const security = securities.get(holding.security_id);
      const view: LinkedHoldingView = {
        name: security?.name?.trim() || security?.ticker || "Unnamed holding",
        kind: securityKindWords(security),
        quantity: holding.quantity,
        value: holding.institution_value,
      };
      if (security?.ticker) view.ticker = security.ticker;
      const costBasis = finite(holding.cost_basis);
      if (costBasis !== undefined) view.cost_basis = costBasis;
      return view;
    })
    .sort((a, b) => b.value - a.value || compare(a.name, b.name));
}

function transactionsView(account: AccountRecord, transactions: TransactionRecord[]): LinkedTransactionView[] {
  return transactions
    .filter((tx) => tx.item_id === account.item_id && tx.account_id === account.account_id)
    .sort((a, b) => compare(b.date, a.date) || compare(a.transaction_id, b.transaction_id))
    .map((tx) => {
      const category = categoryWords(tx.category_detailed ?? tx.category_primary);
      const view: LinkedTransactionView = {
        name: tx.merchant_name ?? tx.name ?? category,
        date: tx.date,
        category,
      };
      // Plaid signs money leaving the account as positive.
      if (tx.amount >= 0) view.money_out = round2(tx.amount);
      else view.money_in = round2(-tx.amount);
      if (tx.pending) view.pending = true;
      return view;
    });
}

function accountView(
  account: AccountRecord,
  category: Category,
  holdings: HoldingRecord[],
  securities: Map<string, SecurityRecord>,
  transactions: TransactionRecord[],
): LinkedAccountView {
  const view: LinkedAccountView = {
    name: accountDisplayName(account),
    account_type: accountTypeWords(account.type, account.subtype),
  };
  const current = finite(account.balances?.current);
  const available = finite(account.balances?.available);
  const limit = finite(account.balances?.limit);
  if (category === "credit_cards" || category === "loans") {
    if (current !== undefined) view.balance_owed = Math.abs(current);
    if (limit !== undefined) view.credit_limit = limit;
    if (available !== undefined && category === "credit_cards") view.available_credit = available;
  } else if (category === "investments") {
    const held = holdingsView(account, holdings, securities);
    const heldTotal = round2(held.reduce((sum, holding) => sum + holding.value, 0));
    const total = current ?? (held.length > 0 ? heldTotal : undefined);
    if (total !== undefined) view.total_value = total;
    if (held.length > 0) view.holdings = held;
  } else {
    if (current !== undefined) view.current_balance = current;
    if (available !== undefined) view.available_balance = available;
  }
  const currency = account.balances?.iso_currency_code?.trim();
  if (currency) view.currency = currency;
  const activity = transactionsView(account, transactions);
  if (activity.length > 0) view.transactions = activity;
  return view;
}

type InstitutionBucket = {
  sortKey: string;
  name: string;
  connections: ConnectionRecord[];
  accounts: AccountRecord[];
};

function institutionView(bucket: InstitutionBucket, category: Category, inputs: ViewInputs): LinkedInstitutionView {
  const accounts = [...bucket.accounts]
    .sort((a, b) => compare(accountDisplayName(a), accountDisplayName(b)) || compare(a.item_id, b.item_id) || compare(a.account_id, b.account_id))
    .map((account) => accountView(account, category, inputs.holdings, inputs.securities, inputs.transactions));
  const needsRelink = bucket.connections.some((connection) => connection.status === "needs_relink");
  const refreshed = bucket.connections
    .map((connection) => connection.last_refreshed_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  return {
    name: bucket.name,
    connection: needsRelink ? "Needs to be reconnected" : "Connected",
    ...(refreshed ? { last_updated: refreshed.slice(0, 10) } : {}),
    accounts: disambiguate(accounts),
  };
}

type ViewInputs = {
  connections: Map<string, ConnectionRecord>;
  accounts: Map<string, AccountRecord>;
  holdings: HoldingRecord[];
  securities: Map<string, SecurityRecord>;
  transactions: TransactionRecord[];
};

/**
 * Build `financial.linked_accounts` from the lane's records. `accounts` must
 * already carry `duplicate_of` and `transactions` must already be retained;
 * both are what `assemble()` holds at the point it calls this.
 */
export function buildLinkedAccountsView(
  inputs: {
    connections: Map<string, ConnectionRecord>;
    accounts: Map<string, AccountRecord>;
    holdings: Map<string, HoldingRecord>;
    securities: Map<string, SecurityRecord>;
    transactions: Map<string, TransactionRecord>;
  },
  derived: DerivedFactsV1,
): LinkedAccountsViewV1 {
  const prepared: ViewInputs = {
    connections: inputs.connections,
    accounts: inputs.accounts,
    holdings: [...inputs.holdings.values()],
    securities: inputs.securities,
    transactions: [...inputs.transactions.values()],
  };
  const buckets = new Map<Category, Map<string, InstitutionBucket>>();
  const orderedAccounts = [...inputs.accounts.entries()].sort(([a], [b]) => compare(a, b));
  for (const [, account] of orderedAccounts) {
    if (account.duplicate_of) continue;
    const connection = inputs.connections.get(account.item_id);
    const name =
      connection?.institution_name?.trim() || account.institution_name?.trim() || "Linked institution";
    const institutionKey = connection?.institution_id ?? account.institution_id ?? `name:${name}`;
    const category = categoryFor(account.type);
    const byInstitution = buckets.get(category) ?? new Map<string, InstitutionBucket>();
    buckets.set(category, byInstitution);
    const bucket = byInstitution.get(institutionKey) ?? { sortKey: `${name}\u0000${institutionKey}`, name, connections: [], accounts: [] };
    byInstitution.set(institutionKey, bucket);
    bucket.accounts.push(account);
    if (connection && !bucket.connections.includes(connection)) bucket.connections.push(connection);
  }

  // Key order is browse order: the kinds of account first, totals last.
  const categories: Partial<Record<Category, LinkedInstitutionView[]>> = {};
  for (const category of CATEGORY_ORDER) {
    const byInstitution = buckets.get(category);
    if (!byInstitution || byInstitution.size === 0) continue;
    const institutions = [...byInstitution.values()]
      .sort((a, b) => compare(a.sortKey, b.sortKey))
      .map((bucket) => institutionView(bucket, category, prepared));
    categories[category] = disambiguate(institutions);
  }
  return {
    schema_version: LINKED_ACCOUNTS_SCHEMA_VERSION,
    ...categories,
    totals: {
      net_worth: derived.net_worth.value,
      total_assets: derived.total_assets.value,
      total_owed: derived.total_liabilities.value,
      cash_in_bank: derived.liquid_cash.value,
      invested: derived.investable_assets.value,
      as_of: derived.computed_at.slice(0, 10),
    },
  };
}

/** True when a stored domain has linked banks but no current readable view. */
export function linkedAccountsViewIsStale(financial: Record<string, unknown> | null | undefined): boolean {
  const connections = financial?.connections_v1;
  if (!connections || typeof connections !== "object" || Object.keys(connections).length === 0) {
    return false;
  }
  const view = financial?.linked_accounts as { schema_version?: unknown } | undefined;
  return view?.schema_version !== LINKED_ACCOUNTS_SCHEMA_VERSION;
}
