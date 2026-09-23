/**
 * Quality scorer for the Plaid vault memory. Used by tests and by the device
 * proof. Every check recomputes its expectation independently from Tier A
 * rather than trusting Tier B, so a bug in the projection shows up here.
 *
 * Rubric (one point each):
 * 1. coverage   - required account types present
 * 2. freshness  - every connection active and refreshed within 24h
 * 3. dedupe     - the same real account linked twice counts once
 * 4. replay     - re-applying the last snapshot / re-deriving is a no-op
 * 5. totals     - derived totals equal Tier A sums within $0.01
 * 6. leak_scan  - the shareable summary holds bands, percentages, counts only
 */

import {
  accountBalanceValue,
  accountIdentityKey,
  applySnapshot,
  classifyAccountType,
  isInvestmentAccount,
  isLiquidCashAccount,
  recomputeDerived,
} from "@/lib/kai/plaid-vault/projection";
import type {
  AccountRecord,
  ConnectionRecord,
  FinancialDomain,
  HoldingRecord,
  PlaidVaultSnapshot,
  SecurityRecord,
  TransactionRecord,
} from "@/lib/kai/plaid-vault/types";

type AnyObj = Record<string, unknown>;

export const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TOTALS_TOLERANCE = 0.01;
export const DEFAULT_REQUIRED_ACCOUNT_TYPES = ["depository", "credit", "loan", "investment"];

export type QualityCheckName =
  | "coverage"
  | "freshness"
  | "dedupe"
  | "replay"
  | "totals"
  | "leak_scan";

export interface QualityCheck {
  name: QualityCheckName;
  score: number;
  passed: boolean;
  details: AnyObj;
}

export interface QualityReport {
  score: number;
  max_score: number;
  passed: boolean;
  checked_at: string;
  checks: Record<QualityCheckName, QualityCheck>;
}

export interface QualityOptions {
  now: string;
  /** Snapshots last applied to this memory; replaying each must change nothing. */
  replays?: Array<{ item_id: string; snapshot: PlaidVaultSnapshot }>;
  requiredAccountTypes?: string[];
}

export interface LeakFinding {
  path: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function values<T>(financial: FinancialDomain, key: keyof FinancialDomain): T[] {
  const record = financial[key];
  return record && typeof record === "object" && !Array.isArray(record)
    ? (Object.values(record as AnyObj) as T[])
    : [];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as AnyObj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function check(name: QualityCheckName, score: number, details: AnyObj): QualityCheck {
  const bounded = Math.max(0, Math.min(1, score));
  return { name, score: Math.round(bounded * 10_000) / 10_000, passed: bounded === 1, details };
}

function near(a: number | null | undefined, b: number): boolean {
  return typeof a === "number" && Math.abs(a - b) <= TOTALS_TOLERANCE;
}

function sum(numbers: number[]): number {
  return Math.round(numbers.reduce((acc, n) => acc + n, 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkCoverage(financial: FinancialDomain, required: string[]): QualityCheck {
  const counts: Record<string, number> = {};
  for (const account of values<AccountRecord>(financial, "accounts_v1")) {
    if (account.duplicate_of) continue;
    counts[account.type] = (counts[account.type] ?? 0) + 1;
  }
  const missing = required.filter((type) => !counts[type]);
  const score = required.length ? (required.length - missing.length) / required.length : 1;
  return check("coverage", score, { counts_by_type: counts, required, missing });
}

function checkFreshness(financial: FinancialDomain, now: string): QualityCheck {
  const nowMs = Date.parse(now);
  const connections = Object.entries(
    (financial.connections_v1 ?? {}) as Record<string, ConnectionRecord>
  );
  const perConnection = connections.map(([itemId, connection]) => {
    const refreshedMs = connection.last_refreshed_at ? Date.parse(connection.last_refreshed_at) : NaN;
    const ageMs = Number.isNaN(refreshedMs) ? null : nowMs - refreshedMs;
    const fresh =
      connection.status === "active" &&
      ageMs !== null &&
      ageMs >= 0 &&
      ageMs < FRESHNESS_WINDOW_MS;
    return { item_id: itemId, status: connection.status, age_ms: ageMs, fresh };
  });
  const fresh = perConnection.filter((entry) => entry.fresh).length;
  const score = perConnection.length ? fresh / perConnection.length : 0;
  return check("freshness", score, {
    connection_count: perConnection.length,
    fresh_count: fresh,
    stale: perConnection.filter((entry) => !entry.fresh),
  });
}

function checkDedupe(financial: FinancialDomain): QualityCheck {
  const accounts = Object.entries((financial.accounts_v1 ?? {}) as Record<string, AccountRecord>);
  const groups = new Map<string, Array<[string, AccountRecord]>>();
  const problems: string[] = [];
  for (const entry of accounts) {
    const identity = accountIdentityKey(entry[1]) ?? `unique:${entry[0]}`;
    groups.set(identity, [...(groups.get(identity) ?? []), entry]);
  }
  let uniqueNetWorth = 0;
  let crossConnectionGroups = 0;
  for (const [identity, members] of groups) {
    const items = new Set(members.map(([, account]) => account.item_id));
    // Accounts inside one connection are distinct accounts.
    const perItem = new Map<string, Array<[string, AccountRecord]>>();
    for (const member of members) {
      perItem.set(member[1].item_id, [...(perItem.get(member[1].item_id) ?? []), member]);
    }
    if (items.size > 1) crossConnectionGroups += 1;
    const counted = members.filter(([, account]) => !account.duplicate_of);
    const expectedCounted = Math.max(...[...perItem.values()].map((rows) => rows.length));
    if (counted.length !== expectedCounted) {
      problems.push(`${identity}: ${counted.length} counted, expected ${expectedCounted}`);
    }
    for (const [key, account] of members) {
      if (!account.duplicate_of) continue;
      const target = members.find(([candidate]) => candidate === account.duplicate_of);
      if (!target || target[1].duplicate_of) problems.push(`${key}: duplicate_of does not name a counted twin`);
    }
    // Each real account counted exactly once: the group check above proves how
    // many rows are counted; this sums that counted view.
    for (const [, account] of counted) {
      const value = accountBalanceValue(account);
      const cls = classifyAccountType(account.type);
      if (cls === "asset") uniqueNetWorth += value;
      if (cls === "liability") uniqueNetWorth -= value;
    }
  }
  uniqueNetWorth = Math.round(uniqueNetWorth * 100) / 100;
  const derivedNetWorth = financial.derived_v1?.net_worth.value;
  if (accounts.length > 0 && !near(derivedNetWorth, uniqueNetWorth)) {
    problems.push(`net worth ${derivedNetWorth} differs from de-duplicated ${uniqueNetWorth}`);
  }
  return check("dedupe", problems.length === 0 ? 1 : 0, {
    account_rows: accounts.length,
    real_accounts: groups.size,
    cross_connection_groups: crossConnectionGroups,
    independent_net_worth: uniqueNetWorth,
    derived_net_worth: derivedNetWorth ?? null,
    problems,
  });
}

function checkReplay(financial: FinancialDomain, options: QualityOptions): QualityCheck {
  const derivedAt = financial.derived_v1?.computed_at ?? options.now;
  const failures: string[] = [];
  let attempts = 1;
  if (!deepEqual(recomputeDerived(financial, derivedAt), financial)) {
    failures.push("recompute changed the memory");
  }
  for (const replay of options.replays ?? []) {
    attempts += 1;
    try {
      const again = applySnapshot(financial, replay.item_id, replay.snapshot, derivedAt);
      if (!deepEqual(again, financial)) failures.push(`replay of ${replay.item_id} changed the memory`);
    } catch (error) {
      failures.push(`replay of ${replay.item_id} threw: ${error instanceof Error ? error.message : "error"}`);
    }
  }
  return check("replay", failures.length === 0 ? 1 : 0, { attempts, failures });
}

function checkTotals(financial: FinancialDomain): QualityCheck {
  const derived = financial.derived_v1;
  const counted = values<AccountRecord>(financial, "accounts_v1").filter((a) => !a.duplicate_of);
  const assets = sum(
    counted.filter((a) => classifyAccountType(a.type) === "asset").map(accountBalanceValue)
  );
  const liabilities = sum(
    counted.filter((a) => classifyAccountType(a.type) === "liability").map(accountBalanceValue)
  );
  const liquid = sum(counted.filter(isLiquidCashAccount).map(accountBalanceValue));
  const investable = sum(counted.filter(isInvestmentAccount).map(accountBalanceValue));
  const expected = {
    total_assets: assets,
    total_liabilities: liabilities,
    net_worth: Math.round((assets - liabilities) * 100) / 100,
    liquid_cash: liquid,
    investable_assets: investable,
  };
  const comparisons = Object.entries(expected).map(([field, value]) => {
    const actual = (derived?.[field as keyof typeof expected] as { value?: number } | undefined)?.value;
    return { field, expected: value, actual: actual ?? null, ok: near(actual, value) };
  });

  const duplicateAccountIds = new Set(
    values<AccountRecord>(financial, "accounts_v1")
      .filter((a) => a.duplicate_of)
      .map((a) => a.account_id)
  );
  const holdings = values<HoldingRecord>(financial, "holdings_v1").filter(
    (h) => !duplicateAccountIds.has(h.account_id) && h.institution_value > 0
  );
  const allocation = derived?.allocation_pct.value ?? {};
  const allocationSum = Object.values(allocation).reduce((a, b) => a + b, 0);
  const allocationOk = holdings.length === 0 ? allocationSum === 0 : Math.abs(allocationSum - 100) <= 0.1;
  comparisons.push({ field: "allocation_pct_sum", expected: holdings.length ? 100 : 0, actual: allocationSum, ok: allocationOk });

  const ok = comparisons.filter((c) => c.ok).length;
  return check("totals", derived ? ok / comparisons.length : 0, { comparisons });
}

const SUMMARY_KEYS = new Set([
  "schema",
  "net_worth_band",
  "liquid_cash_band",
  "investable_assets_band",
  "allocation_pct",
  "cash_flow_trend",
  "income_stability",
  "debt_to_asset_pct",
  "account_type_counts",
  "account_count",
  "institution_count",
  "connection_count",
  "needs_relink_count",
  "recurring_bill_count",
  "last_updated",
]);

const FORBIDDEN_KEY_FRAGMENTS = [
  "mask",
  "account_id",
  "item_id",
  "cusip",
  "merchant",
  "access_token",
  "token",
  "cursor",
  "security_id",
  "transaction_id",
  "persistent",
  "institution_id",
  "institution_name",
  "ticker",
  "balance",
  "amount",
  "name",
];

const BAND_PATTERN = /^(negative )?\$(0|\d+k|\d+M)(-\$(\d+k|\d+M)|\+)$/;

function collectSensitiveStrings(financial: FinancialDomain): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length >= 4) out.add(text.toLowerCase());
  };
  for (const [itemId, connection] of Object.entries(
    (financial.connections_v1 ?? {}) as Record<string, ConnectionRecord>
  )) {
    add(itemId);
    add(connection.access_token);
    add(connection.transactions_cursor);
  }
  for (const account of values<AccountRecord>(financial, "accounts_v1")) {
    add(account.account_id);
    add(account.persistent_account_id);
    add(account.mask);
    add(account.name);
  }
  for (const security of values<SecurityRecord>(financial, "securities_v1")) {
    add(security.security_id);
    add(security.cusip);
  }
  for (const tx of values<TransactionRecord>(financial, "transactions_v1")) {
    add(tx.transaction_id);
    if (!tx.reduced) {
      add(tx.merchant_name);
      add(tx.name);
    }
  }
  return out;
}

function collectRawAmounts(financial: FinancialDomain): Set<number> {
  const out = new Set<number>();
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) out.add(Math.abs(value));
  };
  for (const account of values<AccountRecord>(financial, "accounts_v1")) {
    add(account.balances.current);
    add(account.balances.available);
    add(account.balances.limit);
  }
  for (const holding of values<HoldingRecord>(financial, "holdings_v1")) {
    add(holding.institution_value);
    add(holding.cost_basis);
  }
  for (const tx of values<TransactionRecord>(financial, "transactions_v1")) add(tx.amount);
  const derived = financial.derived_v1;
  if (derived) {
    add(derived.net_worth.value);
    add(derived.total_assets.value);
    add(derived.total_liabilities.value);
    add(derived.liquid_cash.value);
    add(derived.investable_assets.value);
  }
  return out;
}

/** Scan the shareable summary for anything that is not a band, percentage or count. */
export function scanSummaryForLeaks(
  summary: unknown,
  financial: FinancialDomain
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return [{ path: "summary", reason: "summary missing" }];
  }
  const sensitive = collectSensitiveStrings(financial);
  const rawAmounts = collectRawAmounts(financial);

  const visit = (value: unknown, path: string, key: string) => {
    const lowerKey = key.toLowerCase();
    const fragment = FORBIDDEN_KEY_FRAGMENTS.find((f) => lowerKey.includes(f));
    if (fragment) findings.push({ path, reason: `forbidden key (${fragment})` });
    for (const token of sensitive) {
      if (lowerKey.includes(token)) {
        findings.push({ path, reason: "key contains a private identifier, mask or merchant" });
        break;
      }
    }
    if (value === null || value === undefined) return;
    if (path === "summary.last_updated") {
      // Timestamps are digits that can collide with masks ("0000"); check the shape instead.
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        findings.push({ path, reason: "not a timestamp" });
      }
      return;
    }
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      for (const token of sensitive) {
        if (lower.includes(token)) {
          findings.push({ path, reason: "contains a private identifier, mask or merchant" });
          break;
        }
      }
      return;
    }
    if (typeof value === "number") {
      const isWholeSmall = Number.isInteger(value) && Math.abs(value) <= 100;
      if (!isWholeSmall && rawAmounts.has(Math.abs(value))) {
        findings.push({ path, reason: "equals a raw amount" });
      }
      return;
    }
    if (Array.isArray(value)) {
      findings.push({ path, reason: "lists are not allowed in the shareable summary" });
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as AnyObj)) {
        visit(child, `${path}.${childKey}`, childKey);
      }
    }
  };

  const root = summary as AnyObj;
  for (const [key, value] of Object.entries(root)) {
    if (!SUMMARY_KEYS.has(key)) findings.push({ path: `summary.${key}`, reason: "unknown field" });
    visit(value, `summary.${key}`, key);
  }
  for (const bandKey of ["net_worth_band", "liquid_cash_band", "investable_assets_band"]) {
    const band = root[bandKey];
    if (typeof band !== "string" || !BAND_PATTERN.test(band)) {
      findings.push({ path: `summary.${bandKey}`, reason: "not a band" });
    }
  }
  const allocation = root.allocation_pct;
  if (allocation && typeof allocation === "object") {
    for (const [type, pct] of Object.entries(allocation as AnyObj)) {
      if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
        findings.push({ path: `summary.allocation_pct.${type}`, reason: "not a whole percentage" });
      }
    }
  }
  for (const countKey of [
    "account_count",
    "institution_count",
    "connection_count",
    "needs_relink_count",
    "recurring_bill_count",
  ]) {
    const count = root[countKey];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      findings.push({ path: `summary.${countKey}`, reason: "not a count" });
    }
  }
  return findings;
}

function checkLeaks(financial: FinancialDomain): QualityCheck {
  const findings = scanSummaryForLeaks(financial.summary, financial);
  return check("leak_scan", findings.length === 0 ? 1 : 0, { findings });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function scorePlaidVaultQuality(
  financial: FinancialDomain,
  options: QualityOptions
): QualityReport {
  const checks: Record<QualityCheckName, QualityCheck> = {
    coverage: checkCoverage(financial, options.requiredAccountTypes ?? DEFAULT_REQUIRED_ACCOUNT_TYPES),
    freshness: checkFreshness(financial, options.now),
    dedupe: checkDedupe(financial),
    replay: checkReplay(financial, options),
    totals: checkTotals(financial),
    leak_scan: checkLeaks(financial),
  };
  const score = Object.values(checks).reduce((acc, c) => acc + c.score, 0);
  const maxScore = Object.keys(checks).length;
  return {
    score: Math.round(score * 10_000) / 10_000,
    max_score: maxScore,
    passed: Object.values(checks).every((c) => c.passed),
    checked_at: options.now,
    checks,
  };
}
