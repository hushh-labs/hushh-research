"use client";

import { consolidateHoldingsBySymbol } from "@/lib/utils/portfolio-normalize";

/**
 * Deterministic, client-side financial consolidation for the KYC approved-disclosure
 * draft. Runs BEFORE tokenization (zero-knowledge): the LLM never sees real numbers.
 * Reuses the tested per-security merge math from portfolio-normalize.
 */

type AnyRecord = Record<string, unknown>;

export type ConsolidatedAccount = {
  label: string | null;
  endingValue: number | null;
  cashBalance: number | null;
  generatedAt: string | null;
};

export type CollectedAccount = {
  account: ConsolidatedAccount;
  holdings: AnyRecord[];
  key: string;
};

export function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const negative = text.startsWith("(") && text.endsWith(")");
    const sanitized = text.replace(/[,$\s]/g, "").replace(/%/g, "").replace(/[()]/g, "");
    const parsed = Number(negative ? `-${sanitized}` : sanitized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text : null;
}

function recordField(record: AnyRecord | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return undefined;
}

export function accountLabel(accountInfo: AnyRecord | null): string | null {
  if (!accountInfo) return null;
  const brokerage = toText(
    recordField(accountInfo, ["brokerage_name", "brokerage", "institution_name"])
  );
  const type = toText(recordField(accountInfo, ["account_type"]));
  if (brokerage && type) return `${brokerage} ${type}`;
  return brokerage || type || toText(recordField(accountInfo, ["account_holder", "holder_name"]));
}

export function collectAccounts(portfolio: AnyRecord): CollectedAccount[] {
  const rawAccounts =
    Array.isArray(portfolio.accounts) && portfolio.accounts.length
      ? portfolio.accounts.filter(isRecord)
      : [portfolio];

  return rawAccounts.map((acct) => {
    const info = isRecord(acct.account_info) ? acct.account_info : null;
    const summary = isRecord(acct.account_summary) ? acct.account_summary : null;
    const holdings = Array.isArray(acct.holdings) ? acct.holdings.filter(isRecord) : [];
    const label = accountLabel(info);
    const endingValue =
      toNumber(acct.total_value) ??
      toNumber(recordField(summary, ["ending_value", "total_value"]));
    const cashBalance =
      toNumber(acct.cash_balance) ?? toNumber(recordField(summary, ["cash_balance"]));
    const generatedAt = toText(
      acct.generated_at ?? acct.updated_at ?? (summary ? summary.generated_at : undefined)
    );
    const accountNumber = toText(recordField(info, ["account_number"]));
    const key = `${label ?? ""}|${accountNumber ?? ""}`;
    return {
      account: { label, endingValue, cashBalance, generatedAt },
      holdings,
      key,
    };
  });
}

export function dedupAccountsByFreshest(collected: CollectedAccount[]): CollectedAccount[] {
  const byKey = new Map<string, CollectedAccount>();
  collected.forEach((item, index) => {
    // An account with no label and no account number has no stable identity:
    // keep it distinct so we never merge two unrelated accounts.
    if (item.key.replace(/\|/g, "") === "") {
      byKey.set(`__unique_${index}`, item);
      return;
    }
    const existing = byKey.get(item.key);
    if (!existing) {
      byKey.set(item.key, item);
      return;
    }
    // ISO-8601 timestamps compare correctly as strings; freshest wins.
    const existingAt = existing.account.generatedAt ?? "";
    const incomingAt = item.account.generatedAt ?? "";
    if (incomingAt > existingAt) byKey.set(item.key, item);
  });
  return Array.from(byKey.values());
}

export type AllocationSlice = { bucket: string; pct: number };

export type ConsolidatedPortfolio = {
  accounts: ConsolidatedAccount[];
  holdings: AnyRecord[];
  totalValue: number | null;
  holdingsSum: number;
  cashBalance: number | null;
  netUnrealizedGainLoss: number | null;
  allocation: AllocationSlice[];
  reconciliationMismatch: boolean;
};

/**
 * Ensure every holding has a usable `symbol` so the per-symbol merge never drops a
 * position (D2: full disclosure). Name-only holdings (e.g. some bonds) get a stable
 * pseudo-symbol derived from the name; the name is preserved for display.
 */
function ensureSymbol(holding: AnyRecord): AnyRecord {
  if (toText(holding.symbol)) return holding;
  const symbol = toText(holding.ticker ?? holding.security_symbol);
  if (symbol) return { ...holding, symbol };
  const name = toText(
    holding.name ?? holding.security_name ?? holding.instrument_name ?? holding.description
  );
  if (!name) return holding; // no identity at all — merge math will drop it (acceptable)
  return { ...holding, symbol: name.toUpperCase().slice(0, 40), name };
}

function sumNullable(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

function buildAllocation(
  portfolio: AnyRecord,
  holdings: AnyRecord[],
  holdingsSum: number
): AllocationSlice[] {
  const raw = Array.isArray(portfolio.asset_allocation)
    ? portfolio.asset_allocation.filter(isRecord)
    : [];
  if (raw.length) {
    return raw
      .map((slice) => ({
        bucket: toText(slice.bucket) ?? "other",
        pct: toNumber(slice.pct) ?? 0,
      }))
      .filter((slice) => slice.pct > 0);
  }
  if (!holdingsSum) return [];
  const buckets = new Map<string, number>();
  for (const holding of holdings) {
    const bucket =
      toText(holding.instrument_kind) ?? toText(holding.asset_type) ?? "other";
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + (toNumber(holding.market_value) ?? 0));
  }
  return Array.from(buckets.entries())
    .map(([bucket, value]) => ({ bucket, pct: (value / holdingsSum) * 100 }))
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function consolidateFinancialPortfolio(value: unknown): ConsolidatedPortfolio | null {
  const portfolio = Array.isArray(value)
    ? ({ holdings: value } as AnyRecord)
    : isRecord(value)
      ? value
      : null;
  if (!portfolio) return null;

  const collected = dedupAccountsByFreshest(collectAccounts(portfolio));
  const accounts = collected.map((entry) => entry.account);
  const rawHoldings = collected.flatMap((entry) => entry.holdings).map(ensureSymbol);
  const holdings = consolidateHoldingsBySymbol(rawHoldings) as AnyRecord[];

  const holdingsSum = holdings.reduce(
    (sum, holding) => sum + (toNumber(holding.market_value) ?? 0),
    0
  );

  const statementTotal = sumNullable(accounts.map((account) => account.endingValue));
  const portfolioTotal =
    toNumber(portfolio.total_value) ??
    toNumber(
      isRecord(portfolio.account_summary) ? portfolio.account_summary.ending_value : undefined
    );
  const totalValue =
    statementTotal ?? portfolioTotal ?? (holdings.length ? holdingsSum : null);

  const cashBalance =
    sumNullable(accounts.map((account) => account.cashBalance)) ??
    toNumber(portfolio.cash_balance);

  const netUnrealizedGainLoss = sumNullable(
    holdings.map((holding) => toNumber(holding.unrealized_gain_loss))
  );

  const allocation = buildAllocation(portfolio, holdings, holdingsSum);

  const tolerance = Math.max(1, Math.abs(totalValue ?? 0) * 0.01);
  const reconciliationMismatch =
    totalValue !== null &&
    holdings.length > 0 &&
    Math.abs(totalValue - holdingsSum) > tolerance;

  return {
    accounts,
    holdings,
    totalValue,
    holdingsSum,
    cashBalance,
    netUnrealizedGainLoss,
    allocation,
    reconciliationMismatch,
  };
}
