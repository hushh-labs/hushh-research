/**
 * Pure projection of Plaid results into the person's encrypted financial memory.
 *
 * No I/O, no clock: `now` is always injected, so the same inputs give the same
 * output and replaying a snapshot is a no-op. Input objects are never mutated.
 *
 * Tier A (private raw records):  connections_v1, accounts_v1, holdings_v1,
 *                                securities_v1, transactions_v1
 * Tier B (private derived facts): derived_v1, recomputed from Tier A on every change
 * Tier C (shareable summary):    summary, bands, percentages and counts only
 *
 * Retention (founder decision 2026-09-23): transaction detail is kept for 24
 * months; after 90 days a transaction's merchant detail is reduced to its
 * category.
 */

import type { Holding, PortfolioData } from "@/components/kai/types/portfolio";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";

import {
  isUnavailable,
  type AccountRecord,
  type CashFlowTrend,
  type ConnectionLinkInput,
  type ConnectionRecord,
  type DerivedFact,
  type DerivedFactsV1,
  type FinancialDomain,
  type HoldingRecord,
  type IncomeStability,
  type MonthlyCashFlow,
  type PlaidAccount,
  type PlaidHolding,
  type PlaidSecurity,
  type PlaidTx,
  type PlaidVaultSnapshot,
  type RecurringBill,
  type RecurringCadence,
  type SecurityRecord,
  type ShareableSummaryV1,
  type TransactionRecord,
} from "@/lib/kai/plaid-vault/types";

type AnyObj = Record<string, unknown>;
type FinancialInput = FinancialDomain | AnyObj | null | undefined;

export const RAW_TRANSACTION_RETENTION_MONTHS = 24;
export const MERCHANT_DETAIL_RETENTION_DAYS = 90;
const CASH_FLOW_MONTHS = 12;
const STABLE_INCOME_CV_MAX = 0.25;
const TREND_THRESHOLD = 0.02;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): AnyObj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyObj) : null;
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const list = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, T> = {};
  for (const [key, value] of list) out[key] = value;
  return out;
}

function mapOf<T>(financial: FinancialInput, key: string): Map<string, T> {
  const root = asRecord(financial);
  const record = asRecord(root?.[key]) ?? {};
  return new Map(Object.entries(record) as [string, T][]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function parseNow(now: string): Date {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("projection: `now` must be an ISO timestamp.");
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addUtcMonths(date: Date, months: number): Date {
  const out = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, 0, 0, 0, 0)
  );
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return out;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function humanizeCategory(code: string | null): string {
  if (!code) return "Uncategorized";
  const words = code.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Uncategorized";
}

export function accountKey(itemId: string, accountId: string): string {
  return `${itemId}:${accountId}`;
}

export function holdingKey(accountId: string, securityId: string): string {
  return `${accountId}:${securityId}`;
}

// ---------------------------------------------------------------------------
// Account classification and identity
// ---------------------------------------------------------------------------

export type AccountClass = "asset" | "liability" | "other";

export function classifyAccountType(type: string | null | undefined): AccountClass {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "depository" || normalized === "investment" || normalized === "brokerage") {
    return "asset";
  }
  if (normalized === "credit" || normalized === "loan") return "liability";
  return "other";
}

/** Balance used in totals: assets by current (else available), liabilities by amount owed. */
export function accountBalanceValue(account: AccountRecord): number {
  const current = toNumber(account.balances?.current);
  const available = toNumber(account.balances?.available);
  const cls = classifyAccountType(account.type);
  if (cls === "asset") return current ?? available ?? 0;
  if (cls === "liability") return Math.abs(current ?? 0);
  return 0;
}

export function isLiquidCashAccount(account: AccountRecord): boolean {
  return (
    String(account.type).toLowerCase() === "depository" &&
    String(account.subtype || "").toLowerCase() !== "cd"
  );
}

export function isInvestmentAccount(account: AccountRecord): boolean {
  const type = String(account.type).toLowerCase();
  return type === "investment" || type === "brokerage";
}

/**
 * The same real account linked through two connections shares this key:
 * Plaid's persistent_account_id when present, else institution + mask + subtype.
 */
export function accountIdentityKey(account: AccountRecord): string | null {
  if (account.persistent_account_id) return `p:${account.persistent_account_id}`;
  if (account.institution_id && account.mask) {
    return `m:${account.institution_id}:${account.mask}:${account.subtype ?? account.type}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier A record builders
// ---------------------------------------------------------------------------

function toAccountRecord(
  itemId: string,
  connection: ConnectionRecord,
  account: PlaidAccount
): AccountRecord {
  // official_name is intentionally dropped.
  return {
    account_id: account.account_id,
    persistent_account_id: cleanText(account.persistent_account_id),
    item_id: itemId,
    institution_id: connection.institution_id,
    institution_name: connection.institution_name,
    name: cleanText(account.name) ?? "Account",
    mask: cleanText(account.mask),
    type: cleanText(account.type) ?? "other",
    subtype: cleanText(account.subtype),
    balances: {
      available: toNumber(account.balances?.available),
      current: toNumber(account.balances?.current),
      limit: toNumber(account.balances?.limit),
      iso_currency_code: cleanText(account.balances?.iso_currency_code),
    },
    duplicate_of: null,
  };
}

function toSecurityRecord(security: PlaidSecurity): SecurityRecord {
  const type = cleanText(security.type)?.toLowerCase() ?? null;
  return {
    security_id: security.security_id,
    ticker: cleanText(security.ticker_symbol)?.toUpperCase() ?? null,
    name: cleanText(security.name),
    type,
    subtype: cleanText(security.subtype)?.toLowerCase() ?? null,
    cusip: cleanText(security.cusip),
    is_cash_equivalent: security.is_cash_equivalent === true || type === "cash",
    close_price: toNumber(security.close_price),
    sector: cleanText(security.sector),
    industry: cleanText(security.industry),
  };
}

function toHoldingRecord(
  itemId: string,
  holding: PlaidHolding,
  security: SecurityRecord | undefined
): HoldingRecord {
  const quantity = toNumber(holding.quantity) ?? 0;
  const price = toNumber(holding.institution_price);
  const value =
    toNumber(holding.institution_value) ??
    (price !== null ? quantity * price : null) ??
    (security?.close_price !== null && security?.close_price !== undefined
      ? quantity * security.close_price
      : 0);
  return {
    item_id: itemId,
    account_id: holding.account_id,
    security_id: holding.security_id,
    quantity,
    institution_price: price,
    institution_price_as_of: cleanText(holding.institution_price_as_of),
    institution_value: round2(value),
    cost_basis: toNumber(holding.cost_basis),
    iso_currency_code: cleanText(holding.iso_currency_code),
  };
}

function toTransactionRecord(itemId: string, tx: PlaidTx): TransactionRecord {
  const pfc = tx.personal_finance_category ?? null;
  const legacy = Array.isArray(tx.category) ? tx.category.filter(Boolean) : [];
  const location = tx.location
    ? {
        address: cleanText(tx.location.address),
        city: cleanText(tx.location.city),
        region: cleanText(tx.location.region),
        postal_code: cleanText(tx.location.postal_code),
        country: cleanText(tx.location.country),
      }
    : null;
  const hasLocation = location !== null && Object.values(location).some((v) => v !== null);
  const counterparties = Array.isArray(tx.counterparties)
    ? tx.counterparties.map((entry) => ({
        name: cleanText(entry.name),
        type: cleanText(entry.type),
      }))
    : null;
  return {
    transaction_id: tx.transaction_id,
    item_id: itemId,
    account_id: tx.account_id,
    amount: toNumber(tx.amount) ?? 0,
    iso_currency_code: cleanText(tx.iso_currency_code),
    date: tx.date,
    authorized_date: cleanText(tx.authorized_date),
    name: cleanText(tx.name),
    merchant_name: cleanText(tx.merchant_name),
    pending: tx.pending === true,
    payment_channel: cleanText(tx.payment_channel),
    category_primary: cleanText(pfc?.primary) ?? cleanText(legacy[0]),
    category_detailed: cleanText(pfc?.detailed) ?? cleanText(legacy.join("_")),
    location: hasLocation ? location : null,
    counterparties: counterparties && counterparties.length > 0 ? counterparties : null,
    reduced: false,
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export function transactionCategoryLabel(tx: TransactionRecord): string {
  return humanizeCategory(tx.category_detailed ?? tx.category_primary);
}

function reduceTransaction(tx: TransactionRecord): TransactionRecord {
  const label = transactionCategoryLabel(tx);
  return {
    ...tx,
    name: label,
    merchant_name: label,
    location: null,
    counterparties: null,
    reduced: true,
  };
}

/** Drop detail older than 24 months; reduce merchant detail older than 90 days. */
export function applyRetention(
  transactions: Map<string, TransactionRecord>,
  now: string
): Map<string, TransactionRecord> {
  const nowDate = parseNow(now);
  const dropBefore = isoDate(addUtcMonths(nowDate, -RAW_TRANSACTION_RETENTION_MONTHS));
  const reduceBefore = isoDate(addUtcDays(nowDate, -MERCHANT_DETAIL_RETENTION_DAYS));
  const out = new Map<string, TransactionRecord>();
  for (const [id, tx] of transactions) {
    if (tx.date < dropBefore) continue;
    out.set(id, tx.date < reduceBefore ? reduceTransaction(tx) : tx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedupe across connections
// ---------------------------------------------------------------------------

function markDuplicates(
  accounts: Map<string, AccountRecord>,
  connections: Map<string, ConnectionRecord>
): Map<string, AccountRecord> {
  const groups = new Map<string, string[]>();
  for (const [key, account] of accounts) {
    const identity = accountIdentityKey(account);
    if (!identity) continue;
    groups.set(identity, [...(groups.get(identity) ?? []), key]);
  }
  const duplicateOf = new Map<string, string>();
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const ordered = [...keys].sort((a, b) => {
      const accA = accounts.get(a)!;
      const accB = accounts.get(b)!;
      const linkedA = connections.get(accA.item_id)?.linked_at ?? "";
      const linkedB = connections.get(accB.item_id)?.linked_at ?? "";
      if (linkedA !== linkedB) return linkedA < linkedB ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const canonicalKey = ordered[0]!;
    const canonicalItem = accounts.get(canonicalKey)!.item_id;
    for (const key of ordered.slice(1)) {
      // Two accounts in the same connection are two accounts, not a relink.
      if (accounts.get(key)!.item_id !== canonicalItem) duplicateOf.set(key, canonicalKey);
    }
  }
  const out = new Map<string, AccountRecord>();
  for (const [key, account] of accounts) {
    const nextDuplicate = duplicateOf.get(key) ?? null;
    out.set(
      key,
      account.duplicate_of === nextDuplicate ? account : { ...account, duplicate_of: nextDuplicate }
    );
  }
  return out;
}

/** account_ids (Plaid's, item-scoped) belonging to accounts marked as duplicates. */
function duplicateAccountIds(accounts: Map<string, AccountRecord>): Set<string> {
  const ids = new Set<string>();
  for (const account of accounts.values()) {
    if (account.duplicate_of) ids.add(account.account_id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tier B: derived facts
// ---------------------------------------------------------------------------

const BANDS: Array<[number, string]> = [
  [10_000, "$0-$10k"],
  [50_000, "$10k-$50k"],
  [100_000, "$50k-$100k"],
  [250_000, "$100k-$250k"],
  [500_000, "$250k-$500k"],
  [1_000_000, "$500k-$1M"],
  [5_000_000, "$1M-$5M"],
];

export function amountBand(value: number): string {
  const magnitude = Math.abs(value);
  let label = "$5M+";
  for (const [upper, band] of BANDS) {
    if (magnitude < upper) {
      label = band;
      break;
    }
  }
  return value < 0 ? `negative ${label}` : label;
}

function isExcludedFromCashFlow(tx: TransactionRecord): boolean {
  const primary = String(tx.category_primary || "").toUpperCase();
  const detailed = String(tx.category_detailed || "").toUpperCase();
  return (
    primary === "TRANSFER_IN" ||
    primary === "TRANSFER_OUT" ||
    detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"
  );
}

function fact<T>(value: T, now: string, sourceItemIds: Iterable<string>): DerivedFact<T> {
  return { value, computed_at: now, source_item_ids: uniqueSorted(sourceItemIds) };
}

const CADENCES: Array<{ cadence: RecurringCadence; min: number; max: number }> = [
  { cadence: "weekly", min: 6, max: 8 },
  { cadence: "biweekly", min: 13, max: 16 },
  { cadence: "monthly", min: 27, max: 33 },
  { cadence: "quarterly", min: 85, max: 95 },
  { cadence: "annual", min: 355, max: 375 },
];

function detectRecurringBills(spend: TransactionRecord[], now: string): RecurringBill[] {
  const today = isoDate(parseNow(now));
  const groups = new Map<string, TransactionRecord[]>();
  for (const tx of spend) {
    const category = tx.category_detailed ?? tx.category_primary ?? "UNCATEGORIZED";
    const key = `${category}|${Math.round(tx.amount)}`;
    groups.set(key, [...(groups.get(key) ?? []), tx]);
  }
  const bills: RecurringBill[] = [];
  for (const rows of groups.values()) {
    const dates = uniqueSorted(rows.map((tx) => tx.date));
    if (dates.length < 3) continue;
    const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index]!, date));
    const typicalGap = median(gaps);
    const match = CADENCES.find((c) => typicalGap >= c.min && typicalGap <= c.max);
    if (!match) continue;
    const onCadence = gaps.filter((gap) => gap >= match.min && gap <= match.max).length;
    if (onCadence < Math.ceil(gaps.length * 0.66)) continue;
    const lastDate = dates[dates.length - 1]!;
    // A bill that stopped two cycles ago is not a current bill.
    if (daysBetween(lastDate, today) > match.max * 2) continue;
    const latest = [...rows].sort((a, b) =>
      a.date === b.date ? (a.transaction_id < b.transaction_id ? 1 : -1) : a.date < b.date ? 1 : -1
    )[0]!;
    bills.push({
      label: latest.merchant_name ?? latest.name ?? transactionCategoryLabel(latest),
      category: latest.category_detailed ?? latest.category_primary,
      cadence: match.cadence,
      typical_amount: round2(median(rows.map((tx) => tx.amount))),
      occurrences: dates.length,
      last_date: lastDate,
    });
  }
  return bills.sort((a, b) =>
    a.label === b.label ? a.typical_amount - b.typical_amount : a.label < b.label ? -1 : 1
  );
}

function allocationType(security: SecurityRecord | undefined): string {
  if (!security) return "other";
  if (security.is_cash_equivalent) return "cash";
  return security.type ?? "other";
}

function computeDerived(
  connections: Map<string, ConnectionRecord>,
  accounts: Map<string, AccountRecord>,
  holdings: Map<string, HoldingRecord>,
  securities: Map<string, SecurityRecord>,
  transactions: Map<string, TransactionRecord>,
  now: string
): DerivedFactsV1 {
  const nowDate = parseNow(now);
  const counted = [...accounts.values()].filter((account) => !account.duplicate_of);
  const duplicateIds = duplicateAccountIds(accounts);

  let assets = 0;
  let liabilities = 0;
  let liquid = 0;
  let investable = 0;
  const assetItems: string[] = [];
  const liabilityItems: string[] = [];
  const liquidItems: string[] = [];
  const investableItems: string[] = [];
  const typeCounts = new Map<string, number>();
  for (const account of counted) {
    const value = accountBalanceValue(account);
    const cls = classifyAccountType(account.type);
    typeCounts.set(account.type, (typeCounts.get(account.type) ?? 0) + 1);
    if (cls === "asset") {
      assets += value;
      assetItems.push(account.item_id);
    } else if (cls === "liability") {
      liabilities += value;
      liabilityItems.push(account.item_id);
    }
    if (isLiquidCashAccount(account)) {
      liquid += value;
      liquidItems.push(account.item_id);
    }
    if (isInvestmentAccount(account)) {
      investable += value;
      investableItems.push(account.item_id);
    }
  }
  assets = round2(assets);
  liabilities = round2(liabilities);
  const netWorth = round2(assets - liabilities);
  const balanceItems = [...assetItems, ...liabilityItems];

  // Allocation by security type, from holdings in counted accounts only.
  const allocationTotals = new Map<string, number>();
  const allocationItems: string[] = [];
  let allocationTotal = 0;
  for (const holding of holdings.values()) {
    if (duplicateIds.has(holding.account_id)) continue;
    const value = holding.institution_value;
    if (!(value > 0)) continue;
    const type = allocationType(securities.get(holding.security_id));
    allocationTotals.set(type, (allocationTotals.get(type) ?? 0) + value);
    allocationTotal += value;
    allocationItems.push(holding.item_id);
  }
  const allocationPct = sortedRecord(
    [...allocationTotals.entries()].map(([type, value]) => [
      type,
      allocationTotal > 0 ? round2((value / allocationTotal) * 100) : 0,
    ])
  );

  // Monthly cash flow: 12 months ending with the current month.
  const months: string[] = [];
  for (let offset = CASH_FLOW_MONTHS - 1; offset >= 0; offset -= 1) {
    months.push(monthKey(addUtcMonths(new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)), -offset)));
  }
  const monthSet = new Set(months);
  const incomeByMonth = new Map<string, number>(months.map((m) => [m, 0]));
  const spendByMonth = new Map<string, number>(months.map((m) => [m, 0]));
  const activeMonths = new Set<string>();
  const cashFlowItems: string[] = [];
  const spendRows: TransactionRecord[] = [];
  for (const tx of transactions.values()) {
    if (tx.pending || duplicateIds.has(tx.account_id) || isExcludedFromCashFlow(tx)) continue;
    if (tx.amount > 0) spendRows.push(tx);
    const month = tx.date.slice(0, 7);
    if (!monthSet.has(month)) continue;
    activeMonths.add(month);
    cashFlowItems.push(tx.item_id);
    if (tx.amount < 0) incomeByMonth.set(month, incomeByMonth.get(month)! - tx.amount);
    else spendByMonth.set(month, spendByMonth.get(month)! + tx.amount);
  }
  const monthlyCashFlow: MonthlyCashFlow[] = months.map((month) => {
    const income = round2(incomeByMonth.get(month)!);
    const spend = round2(spendByMonth.get(month)!);
    return { month, income, spend, net: round2(income - spend) };
  });

  // Stability and trend use complete months only, from the first month with activity.
  const currentMonth = months[months.length - 1];
  const firstActive = months.find((month) => activeMonths.has(month));
  const complete = monthlyCashFlow.filter(
    (row) => row.month !== currentMonth && firstActive !== undefined && row.month >= firstActive
  );
  const incomes = complete.map((row) => row.income);
  const meanIncome = incomes.length ? incomes.reduce((a, b) => a + b, 0) / incomes.length : 0;
  let cv: number | null = null;
  if (incomes.length >= 2 && meanIncome > 0) {
    const variance = incomes.reduce((acc, v) => acc + (v - meanIncome) ** 2, 0) / incomes.length;
    cv = Math.round((Math.sqrt(variance) / meanIncome) * 10_000) / 10_000;
  }
  const incomeStability: IncomeStability = {
    coefficient_of_variation: cv,
    months_observed: incomes.length,
    label:
      cv === null || incomes.length < 3 ? "unknown" : cv <= STABLE_INCOME_CV_MAX ? "stable" : "variable",
  };

  const recent = complete.slice(-3);
  let trend: CashFlowTrend = "flat";
  if (recent.length > 0) {
    const avgNet = recent.reduce((a, r) => a + r.net, 0) / recent.length;
    const avgIncome = recent.reduce((a, r) => a + r.income, 0) / recent.length;
    const ratio = avgNet / Math.max(avgIncome, 1);
    trend = ratio > TREND_THRESHOLD ? "positive" : ratio < -TREND_THRESHOLD ? "negative" : "flat";
  }

  const recurring = detectRecurringBills(spendRows, now);
  const recurringItems = spendRows.map((tx) => tx.item_id);

  return {
    schema: "plaid-derived-v1",
    computed_at: now,
    total_assets: fact(assets, now, assetItems),
    total_liabilities: fact(liabilities, now, liabilityItems),
    net_worth: fact(netWorth, now, balanceItems),
    net_worth_band: fact(amountBand(netWorth), now, balanceItems),
    liquid_cash: fact(round2(liquid), now, liquidItems),
    investable_assets: fact(round2(investable), now, investableItems),
    allocation_pct: fact(allocationPct, now, allocationItems),
    monthly_cash_flow: fact(monthlyCashFlow, now, cashFlowItems),
    cash_flow_trend: fact(trend, now, cashFlowItems),
    recurring_bills: fact(recurring, now, recurring.length ? recurringItems : []),
    income_stability: fact(incomeStability, now, cashFlowItems),
    debt_to_asset_ratio: fact(
      assets > 0 ? Math.round((liabilities / assets) * 10_000) / 10_000 : null,
      now,
      balanceItems
    ),
    account_type_counts: fact(sortedRecord(typeCounts.entries()), now, counted.map((a) => a.item_id)),
  };
}

// ---------------------------------------------------------------------------
// Tier C: shareable summary
// ---------------------------------------------------------------------------

function computeSummary(
  derived: DerivedFactsV1,
  connections: Map<string, ConnectionRecord>,
  now: string
): ShareableSummaryV1 {
  const institutions = new Set<string>();
  let needsRelink = 0;
  let lastRefreshed: string | null = null;
  for (const [itemId, connection] of connections) {
    institutions.add(connection.institution_id ?? `item:${itemId}`);
    if (connection.status === "needs_relink") needsRelink += 1;
    if (connection.last_refreshed_at && (!lastRefreshed || connection.last_refreshed_at > lastRefreshed)) {
      lastRefreshed = connection.last_refreshed_at;
    }
  }
  const allocation = sortedRecord(
    Object.entries(derived.allocation_pct.value).map(([type, pct]) => [type, Math.round(pct)])
  );
  const ratio = derived.debt_to_asset_ratio.value;
  const accountCount = Object.values(derived.account_type_counts.value).reduce((a, b) => a + b, 0);
  return {
    schema: "plaid-summary-v1",
    net_worth_band: derived.net_worth_band.value,
    liquid_cash_band: amountBand(derived.liquid_cash.value),
    investable_assets_band: amountBand(derived.investable_assets.value),
    allocation_pct: allocation,
    cash_flow_trend: derived.cash_flow_trend.value,
    income_stability: derived.income_stability.value.label,
    debt_to_asset_pct: ratio === null ? null : Math.round(ratio * 100),
    account_type_counts: { ...derived.account_type_counts.value },
    account_count: accountCount,
    institution_count: institutions.size,
    connection_count: connections.size,
    needs_relink_count: needsRelink,
    recurring_bill_count: derived.recurring_bills.value.length,
    last_updated: lastRefreshed ?? now,
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface TierA {
  connections: Map<string, ConnectionRecord>;
  accounts: Map<string, AccountRecord>;
  holdings: Map<string, HoldingRecord>;
  securities: Map<string, SecurityRecord>;
  transactions: Map<string, TransactionRecord>;
}

function readTierA(financial: FinancialInput): TierA {
  return {
    connections: mapOf<ConnectionRecord>(financial, "connections_v1"),
    accounts: mapOf<AccountRecord>(financial, "accounts_v1"),
    holdings: mapOf<HoldingRecord>(financial, "holdings_v1"),
    securities: mapOf<SecurityRecord>(financial, "securities_v1"),
    transactions: mapOf<TransactionRecord>(financial, "transactions_v1"),
  };
}

function garbageCollectSecurities(
  securities: Map<string, SecurityRecord>,
  holdings: Map<string, HoldingRecord>
): Map<string, SecurityRecord> {
  const referenced = new Set([...holdings.values()].map((holding) => holding.security_id));
  return new Map([...securities].filter(([id]) => referenced.has(id)));
}

/** Rebuild Tier B and C from Tier A (and re-apply retention and dedupe). */
function assemble(financial: FinancialInput, tierA: TierA, now: string): FinancialDomain {
  const transactions = applyRetention(tierA.transactions, now);
  const accounts = markDuplicates(tierA.accounts, tierA.connections);
  const securities = garbageCollectSecurities(tierA.securities, tierA.holdings);
  const next: FinancialDomain = {
    ...(asRecord(financial) ?? {}),
    connections_v1: sortedRecord(tierA.connections),
    accounts_v1: sortedRecord(accounts),
    holdings_v1: sortedRecord(tierA.holdings),
    securities_v1: sortedRecord(securities),
    transactions_v1: sortedRecord(transactions),
  };
  if (tierA.connections.size === 0) {
    delete next.derived_v1;
    delete next.summary;
    return next;
  }
  const derived = computeDerived(
    tierA.connections,
    accounts,
    tierA.holdings,
    securities,
    transactions,
    now
  );
  next.derived_v1 = derived;
  next.summary = computeSummary(derived, tierA.connections, now);
  return next;
}

/**
 * Re-derive Tier B/C and re-apply retention without new Plaid results. Run on
 * unlock so ageing rules take effect even when no refresh succeeds.
 */
export function recomputeDerived(financial: FinancialInput, now: string): FinancialDomain {
  return assemble(financial, readTierA(financial), now);
}

/** Record a freshly exchanged connection. Re-linking the same item keeps its cursor. */
export function applyConnectionLink(
  financial: FinancialInput,
  link: ConnectionLinkInput,
  now: string
): FinancialDomain {
  const itemId = cleanText(link.item_id);
  const accessToken = cleanText(link.access_token);
  if (!itemId || !accessToken) {
    throw new Error("applyConnectionLink: item_id and access_token are required.");
  }
  const tierA = readTierA(financial);
  const existing = tierA.connections.get(itemId);
  tierA.connections.set(itemId, {
    access_token: accessToken,
    institution_id: cleanText(link.institution?.id) ?? existing?.institution_id ?? null,
    institution_name: cleanText(link.institution?.name) ?? existing?.institution_name ?? null,
    products: uniqueSorted(link.products ?? []),
    linked_at: existing?.linked_at ?? now,
    transactions_cursor: existing?.transactions_cursor ?? null,
    last_refreshed_at: existing?.last_refreshed_at ?? null,
    status: "active",
  });
  return assemble(financial, tierA, now);
}

/**
 * Apply one `/snapshot` result for `itemId`. Accounts and holdings are full
 * pictures for the item and replace what was there; transactions are a
 * cursor delta (added/modified upserted, removed deleted). The new cursor is
 * written into the connection in the same returned object as the records it
 * describes, so the two can never be persisted apart.
 *
 * An item error marks the connection `needs_relink` and leaves every prior
 * record in place.
 */
export function applySnapshot(
  financial: FinancialInput,
  itemId: string,
  snapshot: PlaidVaultSnapshot,
  now: string
): FinancialDomain {
  const tierA = readTierA(financial);
  const connection = tierA.connections.get(itemId);
  if (!connection) throw new Error("applySnapshot: no connection for this item.");
  if (snapshot.item?.item_id && snapshot.item.item_id !== itemId) {
    throw new Error("applySnapshot: snapshot belongs to a different item.");
  }

  if (snapshot.item?.error) {
    tierA.connections.set(itemId, { ...connection, status: "needs_relink" });
    return assemble(financial, tierA, now);
  }

  const nextConnection: ConnectionRecord = {
    ...connection,
    institution_id: connection.institution_id ?? cleanText(snapshot.item?.institution_id),
    products:
      Array.isArray(snapshot.item?.products) && snapshot.item.products.length > 0
        ? uniqueSorted(snapshot.item.products)
        : connection.products,
    status: "active",
    last_refreshed_at: now,
  };

  // Accounts: full picture for this item.
  for (const [key, account] of [...tierA.accounts]) {
    if (account.item_id === itemId) tierA.accounts.delete(key);
  }
  for (const account of snapshot.accounts ?? []) {
    tierA.accounts.set(
      accountKey(itemId, account.account_id),
      toAccountRecord(itemId, nextConnection, account)
    );
  }

  // Investments: full picture when available; otherwise keep what we had.
  if (snapshot.investments && !isUnavailable(snapshot.investments)) {
    for (const security of snapshot.investments.securities ?? []) {
      tierA.securities.set(security.security_id, toSecurityRecord(security));
    }
    for (const [key, holding] of [...tierA.holdings]) {
      if (holding.item_id === itemId) tierA.holdings.delete(key);
    }
    for (const holding of snapshot.investments.holdings ?? []) {
      tierA.holdings.set(
        holdingKey(holding.account_id, holding.security_id),
        toHoldingRecord(itemId, holding, tierA.securities.get(holding.security_id))
      );
    }
  }

  // Transactions: cursor delta.
  if (snapshot.transactions && !isUnavailable(snapshot.transactions)) {
    const delta = snapshot.transactions;
    for (const removed of delta.removed ?? []) {
      const existing = tierA.transactions.get(removed.transaction_id);
      if (existing && existing.item_id === itemId) tierA.transactions.delete(removed.transaction_id);
    }
    for (const tx of [...(delta.added ?? []), ...(delta.modified ?? [])]) {
      tierA.transactions.set(tx.transaction_id, toTransactionRecord(itemId, tx));
    }
    nextConnection.transactions_cursor = cleanText(delta.next_cursor) ?? connection.transactions_cursor;
  }

  tierA.connections.set(itemId, nextConnection);
  return assemble(financial, tierA, now);
}

/** Remove a connection and every Tier A record it brought, then re-derive. */
export function removeConnection(
  financial: FinancialInput,
  itemId: string,
  now: string
): FinancialDomain {
  const tierA = readTierA(financial);
  tierA.connections.delete(itemId);
  const dropItem = <T extends { item_id: string }>(map: Map<string, T>) =>
    new Map([...map].filter(([, record]) => record.item_id !== itemId));
  return assemble(
    financial,
    {
      connections: tierA.connections,
      accounts: dropItem(tierA.accounts),
      holdings: dropItem(tierA.holdings),
      securities: tierA.securities,
      transactions: dropItem(tierA.transactions),
    },
    now
  );
}

// ---------------------------------------------------------------------------
// Rendering bridge for existing finance screens
// ---------------------------------------------------------------------------

/**
 * Build the `PortfolioData` the finance screens already render, from Tier A
 * investment holdings. Holdings in duplicate accounts are skipped so a bank
 * linked twice does not double the portfolio. Returns null without holdings.
 */
export function toPortfolioData(financial: FinancialInput): PortfolioData | null {
  const tierA = readTierA(financial);
  const accounts = markDuplicates(tierA.accounts, tierA.connections);
  const accountsById = new Map<string, AccountRecord>();
  for (const account of accounts.values()) accountsById.set(account.account_id, account);
  const duplicateIds = duplicateAccountIds(accounts);

  const rows: Holding[] = [];
  const itemIds = new Set<string>();
  const accountIds = new Set<string>();
  let cash = 0;
  let total = 0;
  const holdingEntries = [...tierA.holdings.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [, holding] of holdingEntries) {
    if (duplicateIds.has(holding.account_id)) continue;
    const security = tierA.securities.get(holding.security_id);
    const account = accountsById.get(holding.account_id);
    const connection = tierA.connections.get(holding.item_id);
    const symbol = security?.ticker ?? holding.security_id;
    const marketValue = holding.institution_value;
    const isCash = security?.is_cash_equivalent === true;
    const equityLike =
      !isCash && Boolean(security?.ticker) && ["equity", "etf", "mutual fund"].includes(security?.type ?? "");
    const unrealized =
      holding.cost_basis !== null ? round2(marketValue - holding.cost_basis) : undefined;
    total += marketValue;
    if (isCash) cash += marketValue;
    itemIds.add(holding.item_id);
    accountIds.add(holding.account_id);
    rows.push({
      symbol,
      symbol_cusip: security?.cusip ?? undefined,
      identifier_type: security?.ticker ? "ticker" : "derived",
      name: security?.name ?? "Unknown",
      quantity: holding.quantity,
      price: holding.institution_price ?? security?.close_price ?? 0,
      market_value: marketValue,
      cost_basis: holding.cost_basis ?? undefined,
      unrealized_gain_loss: unrealized,
      unrealized_gain_loss_pct:
        unrealized !== undefined && holding.cost_basis
          ? Math.round((unrealized / holding.cost_basis) * 1_000_000) / 10_000
          : undefined,
      asset_class: security?.type ?? undefined,
      asset_type: security?.subtype ?? security?.type ?? undefined,
      sector: security?.sector ?? undefined,
      industry: security?.industry ?? undefined,
      is_cash_equivalent: isCash,
      is_investable: equityLike,
      analyze_eligible: equityLike,
      debate_eligible: equityLike,
      optimize_eligible: equityLike,
      symbol_source: security?.ticker ? "plaid_security_ticker" : "plaid_security_identifier",
      symbol_kind: "plaid_brokerage_symbol",
      source_type: "plaid",
      source_id: `${holding.item_id}:${holding.account_id}:${holding.security_id}`,
      item_id: holding.item_id,
      account_id: holding.account_id,
      account_name: account?.name,
      account_mask: account?.mask ?? undefined,
      account_subtype: account?.subtype ?? undefined,
      persistent_account_id: account?.persistent_account_id ?? undefined,
      institution_id: connection?.institution_id ?? undefined,
      institution_name: connection?.institution_name ?? undefined,
      last_synced_at: connection?.last_refreshed_at ?? undefined,
      institution_price_as_of: holding.institution_price_as_of ?? undefined,
      is_editable: false,
      security_id: holding.security_id,
    });
  }
  if (rows.length === 0) return null;

  const institutionNames = uniqueSorted(
    [...itemIds]
      .map((id) => tierA.connections.get(id)?.institution_name)
      .filter((name): name is string => Boolean(name))
  );
  const lastSynced =
    [...itemIds]
      .map((id) => tierA.connections.get(id)?.last_refreshed_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop() ?? null;
  const single = institutionNames.length === 1 ? institutionNames[0] : undefined;
  const normalized = normalizeStoredPortfolio({
    account_info: {
      account_type: "investment_accounts",
      brokerage_name: single ?? "Multiple brokerages",
      institution_name: single ?? "Multiple institutions",
    },
    account_summary: {
      ending_value: round2(total),
      cash_balance: round2(cash),
      equities_value: round2(Math.max(total - cash, 0)),
    },
    holdings: rows,
    total_value: round2(total),
    cash_balance: round2(cash),
    source_metadata: {
      source_type: "plaid",
      source_label: "Plaid",
      is_editable: false,
      sync_status: "completed",
      last_synced_at: lastSynced,
      institution_names: institutionNames,
      item_count: itemIds.size,
      account_count: accountIds.size,
      requires_explicit_source_selection_for_analysis: false,
    },
  }) as PortfolioData;
  return normalized;
}
