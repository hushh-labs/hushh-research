import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { getActiveSource, getActiveStatementSnapshotId, getStatementPortfolio, getPlaidPortfolio, getStatementSnapshots } from "@/lib/kai/brokerage/financial-sources";
import { normalizeStatementPortfolio } from "@/lib/kai/brokerage/statement-portfolio";
import { loadFinancialForVault } from "@/lib/kai/plaid-vault/vault-sync";
import { financeDigest, type FinanceSource } from "./contract";
import { assertAdvisorSourceIntegrity } from "./advisor-source-integrity";
import { requireFinanceSession, type FinanceShareContext } from "@/lib/services/finance-sharing-service";

/** Source pinning is local only. A UI tab change never redirects a live share. */
export function resolveFinancePortfolio(financial: Record<string, unknown>, source: FinanceSource): PortfolioData | null {
  if (source.representation === "current-v7") {
    if (getActiveSource(financial) !== source.kind || (source.kind === "statement" && getActiveStatementSnapshotId(financial) !== source.snapshotId)) return null;
    return source.kind === "plaid" ? getPlaidPortfolio(financial) : getStatementPortfolio(financial);
  }
  if (source.kind === "plaid") return getPlaidPortfolio(financial);
  if (source.snapshotId) {
    const snapshot = getStatementSnapshots(financial).find(s => s.id === source.snapshotId);
    if (!snapshot) return null;
    // V7 artifacts may only reference a sealed document. Never substitute the active core.
    if (snapshot.canonical_v2 && typeof snapshot.canonical_v2 === "object") {
      return normalizeStatementPortfolio(snapshot.canonical_v2 as Record<string, unknown>, snapshot);
    }
    if (Array.isArray(snapshot.holdings)) return normalizeStatementPortfolio(snapshot, snapshot);
    return null;
  }
  // Legacy sources without a snapshot stay legacy; an import requires new approval.
  if (getStatementSnapshots(financial).length) return null;
  return getStatementPortfolio(financial);
}

export async function readSavedFinance(context: FinanceShareContext, source: FinanceSource, allowCashOnly = false) {
  requireFinanceSession(context);
  const financial = await loadFinancialForVault(context);
  requireFinanceSession(context);
  if (!financial) throw new Error("This portfolio source is no longer available.");
  const resolvedSource: FinanceSource = String(financial.pkm_contract_version || "").startsWith("7.") && !source.representation
    ? { ...source, representation: "current-v7" } : source;
  const portfolio = resolveFinancePortfolio(financial, resolvedSource);
  if (!portfolio) throw new Error("Open the approved portfolio source to refresh this share.");
  if (allowCashOnly) assertAdvisorSourceIntegrity(financial, resolvedSource, portfolio);
  const cash = portfolio.account_summary?.cash_balance ?? portfolio.cash_balance;
  const cashOnly = !portfolio.holdings?.length && allowCashOnly && typeof cash === "number" && Number.isFinite(cash) && cash >= 0;
  if (!portfolio.holdings?.length && !cashOnly) throw new Error("This source has no shareable positions or reported cash balance.");
  const declaredTotal = portfolio.total_value ?? portfolio.account_summary?.ending_value;
  if (cashOnly && declaredTotal !== undefined && declaredTotal !== null && declaredTotal !== cash) {
    throw new Error("This source's total does not match its reported cash balance, so it cannot be shared in full.");
  }
  const modelPortfolio = cashOnly && declaredTotal == null ? { ...portfolio, total_value: cash } : portfolio;
  const core = financial.financial_core_v7 as Record<string, unknown> | undefined;
  const accountCurrencies = source.kind === "plaid" ? [financial.accounts_v1, core?.accounts].flatMap(root =>
    root && typeof root === "object" ? Object.values(root).flatMap(raw => {
      const account = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const balances = account.balances && typeof account.balances === "object" ? account.balances as Record<string, unknown> : {};
      return [account.iso_currency_code, account.currency, balances.iso_currency_code].filter((v): v is string => typeof v === "string" && Boolean(v));
    }) : []) : [];
  if (accountCurrencies.some(currency => currency !== "USD") || (portfolio.holdings || []).some(h => (h.iso_currency_code || h.currency || "USD") !== "USD")) {
    throw new Error("This sharing view currently supports USD portfolios. No currency conversion has been applied.");
  }
  if (source.kind === "plaid" && (portfolio.holdings || []).some(h => !h.persistent_account_id && !h.account_id)) throw new Error("Account membership could not be verified for this linked portfolio.");
  const accounts = [...new Set((portfolio.holdings || []).map(h => h.persistent_account_id || h.account_id || h.account_mask || "legacy"))].sort();
  const connections = source.kind === "plaid" ? Object.keys((financial.connections_v1 as object) || {}).sort() : [];
  // Identity roster only: changing balances remains eligible; adding/removing an account does not.
  const artifacts = resolvedSource.representation === "current-v7" ? getStatementSnapshots(financial).map(s => [s.id, s.artifact_ref]) : [];
  const sourceFence = await financeDigest(JSON.stringify([resolvedSource, accounts, connections, Object.keys((core?.accounts as object) || {}).sort(), artifacts, portfolio.account_info?.account_number ?? null]));
  requireFinanceSession(context);
  return { model: mapPortfolioToDashboardViewModel(modelPortfolio), portfolio: modelPortfolio, sourceFence, source: resolvedSource };
}
