import {
  accountBalanceValue,
  classifyAccountType,
  isInvestmentAccount,
  isLiquidCashAccount,
  toPortfolioData,
} from "./projection";
import type {
  AccountRecord,
  DerivedFactsV1,
  FinancialDomain,
  ShareableBankAccountsV1,
  ShareableCashFlowV1,
  ShareableLiabilitiesV1,
  ShareableSummaryV1,
} from "./types";

export interface PlaidItemProjectionSummary {
  accountCount: number;
  netAmount: number;
  formattedNetAmount: string;
  summaryLabel: string;
}

export interface PlaidVaultMetricItem {
  key: "net_worth" | "liquid_cash" | "investable";
  label: string;
  formatted: string;
}

export interface PlaidVaultShareableScopeItem {
  key: "summary" | "accounts" | "liabilities" | "portfolio" | "cashflow";
  label: string;
  valueLabel: string | null;
  machineScope: string;
}

export interface PlaidVaultProjectionSummary {
  byItemId: Record<string, PlaidItemProjectionSummary>;
  hasData: boolean;
  metrics: PlaidVaultMetricItem[];
  scopes: PlaidVaultShareableScopeItem[];
  totalsLine: string | null;
  projectedScopesLine: string | null;
}

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatPlaidUsd(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : Math.round(value * 100) / 100;
  return USD_FORMATTER.format(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizePlaidVaultProjection(
  financialData: Record<string, unknown> | null | undefined,
): PlaidVaultProjectionSummary {
  if (!isRecord(financialData)) {
    return {
      byItemId: {},
      hasData: false,
      metrics: [],
      scopes: [],
      totalsLine: null,
      projectedScopesLine: null,
    };
  }

  const perItem = new Map<string, { accountCount: number; netAmount: number }>();
  let fallbackAssets = 0;
  let fallbackLiabilities = 0;
  let fallbackLiquid = 0;
  let fallbackInvestable = 0;
  let countedAccounts = 0;

  if (isRecord(financialData.accounts_v1)) {
    for (const rawAccount of Object.values(financialData.accounts_v1)) {
      if (!isRecord(rawAccount)) continue;
      const account = rawAccount as unknown as AccountRecord;
      if (account.duplicate_of || !account.item_id) continue;
      countedAccounts += 1;
      const value = accountBalanceValue(account);
      const cls = classifyAccountType(account.type);
      const delta = cls === "liability" ? -value : value;
      if (cls === "asset") fallbackAssets += value;
      else if (cls === "liability") fallbackLiabilities += value;
      if (isLiquidCashAccount(account)) fallbackLiquid += value;
      if (isInvestmentAccount(account)) fallbackInvestable += value;

      const current = perItem.get(account.item_id) ?? { accountCount: 0, netAmount: 0 };
      current.accountCount += 1;
      current.netAmount += delta;
      perItem.set(account.item_id, current);
    }
  }

  const byItemId: Record<string, PlaidItemProjectionSummary> = {};
  for (const [itemId, entry] of perItem.entries()) {
    const formattedNetAmount = formatPlaidUsd(entry.netAmount);
    const noun = entry.accountCount === 1 ? "account" : "accounts";
    byItemId[itemId] = {
      accountCount: entry.accountCount,
      netAmount: Math.round(entry.netAmount * 100) / 100,
      formattedNetAmount,
      summaryLabel: `${entry.accountCount} ${noun} · ${formattedNetAmount}`,
    };
  }

  const rawDerived = isRecord(financialData.derived_v1)
    ? (financialData.derived_v1 as unknown as Partial<DerivedFactsV1>)
    : null;
  const hasDerived = rawDerived?.schema === "plaid-derived-v1";
  const netWorth = hasDerived
    ? finiteNumber(rawDerived?.net_worth?.value)
    : countedAccounts > 0
      ? fallbackAssets - fallbackLiabilities
      : null;
  const liquidCash = hasDerived
    ? finiteNumber(rawDerived?.liquid_cash?.value)
    : countedAccounts > 0
      ? fallbackLiquid
      : null;
  const investable = hasDerived
    ? finiteNumber(rawDerived?.investable_assets?.value)
    : countedAccounts > 0
      ? fallbackInvestable
      : null;

  const metrics: PlaidVaultMetricItem[] = [];
  const totalParts: string[] = [];
  if (netWorth !== null) {
    const formatted = formatPlaidUsd(netWorth);
    metrics.push({ key: "net_worth", label: "Net worth", formatted });
    totalParts.push(`Net worth ${formatted}`);
  }
  if (liquidCash !== null) {
    const formatted = formatPlaidUsd(liquidCash);
    metrics.push({ key: "liquid_cash", label: "Liquid cash", formatted });
    totalParts.push(`Liquid cash ${formatted}`);
  }
  if (investable !== null) {
    const formatted = formatPlaidUsd(investable);
    metrics.push({ key: "investable", label: "Investable", formatted });
    totalParts.push(`Investable ${formatted}`);
  }
  const totalsLine = totalParts.length > 0 ? totalParts.join(" · ") : null;

  const scopes: PlaidVaultShareableScopeItem[] = [];
  const scopeLabels: string[] = [];
  const rawSummary = isRecord(financialData.summary)
    ? (financialData.summary as unknown as Partial<ShareableSummaryV1>)
    : null;
  if (
    rawSummary?.schema === "plaid-summary-v1" &&
    typeof rawSummary.net_worth_band === "string" &&
    rawSummary.net_worth_band.trim().length > 0
  ) {
    const band = rawSummary.net_worth_band.trim();
    scopes.push({
      key: "summary",
      label: "Financial Summary",
      valueLabel: band,
      machineScope: "attr.financial.summary.*",
    });
    scopeLabels.push(`Financial Summary (${band})`);
  }

  const rawAccounts = isRecord(financialData.accounts)
    ? (financialData.accounts as unknown as Partial<ShareableBankAccountsV1>)
    : null;
  if (rawAccounts?.schema === "plaid-accounts-v1") {
    const bankBalance = finiteNumber(rawAccounts.total_depository_balance) ?? finiteNumber(rawAccounts.cash_in_bank);
    const valueLabel = bankBalance !== null ? formatPlaidUsd(bankBalance) : null;
    scopes.push({
      key: "accounts",
      label: "Bank Accounts",
      valueLabel,
      machineScope: "attr.financial.accounts.*",
    });
    scopeLabels.push(valueLabel ? `Bank Accounts (${valueLabel})` : "Bank Accounts");
  }

  const rawLiabilities = isRecord(financialData.liabilities)
    ? (financialData.liabilities as unknown as Partial<ShareableLiabilitiesV1>)
    : null;
  if (rawLiabilities?.schema === "plaid-liabilities-v1") {
    const owed = finiteNumber(rawLiabilities.total_owed);
    const valueLabel = owed !== null ? formatPlaidUsd(owed) : null;
    scopes.push({
      key: "liabilities",
      label: "Credit & Loans",
      valueLabel,
      machineScope: "attr.financial.liabilities.*",
    });
    scopeLabels.push(valueLabel ? `Credit & Loans (${valueLabel})` : "Credit & Loans");
  }

  const computedPortfolio = toPortfolioData(financialData as FinancialDomain);
  const directPortfolio = isRecord(financialData.portfolio)
    ? (financialData.portfolio as {
        total_value?: unknown;
        account_summary?: { ending_value?: unknown };
        holdings?: unknown[];
      })
    : null;
  const portfolio = computedPortfolio ?? directPortfolio;
  if (portfolio) {
    const totalValue =
      finiteNumber(portfolio.total_value) ??
      finiteNumber(portfolio.account_summary?.ending_value);
    const hasHoldings = Array.isArray(portfolio.holdings) && portfolio.holdings.length > 0;
    if (totalValue !== null || hasHoldings) {
      const valueLabel = totalValue !== null ? formatPlaidUsd(totalValue) : null;
      scopes.push({
        key: "portfolio",
        label: "Investment Portfolio",
        valueLabel,
        machineScope: "attr.financial.portfolio.*",
      });
      scopeLabels.push(
        valueLabel ? `Investment Portfolio (${valueLabel})` : "Investment Portfolio",
      );
    }
  }

  const rawCashFlow = isRecord(financialData.cashflow)
    ? (financialData.cashflow as unknown as Partial<ShareableCashFlowV1>)
    : null;
  if (rawCashFlow?.schema === "plaid-cashflow-v1") {
    const billsCount = finiteNumber(rawCashFlow.recurring_bill_count);
    const valueLabel = billsCount !== null && billsCount > 0 ? `${billsCount} bills` : null;
    scopes.push({
      key: "cashflow",
      label: "Cash Flow & Recurring",
      valueLabel,
      machineScope: "attr.financial.cashflow.*",
    });
    scopeLabels.push(
      valueLabel ? `Cash Flow & Recurring (${valueLabel})` : "Cash Flow & Recurring",
    );
  }

  const projectedScopesLine =
    scopeLabels.length > 0 ? `Shareable scopes: ${scopeLabels.join(" · ")}` : null;

  return {
    byItemId,
    hasData: Boolean(
      Object.keys(byItemId).length > 0 || totalsLine || projectedScopesLine,
    ),
    metrics,
    scopes,
    totalsLine,
    projectedScopesLine,
  };
}
