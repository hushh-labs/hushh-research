import { getStatementSnapshots } from "@/lib/kai/brokerage/financial-sources";
import { toPortfolioData as toVaultPortfolioData } from "@/lib/kai/plaid-vault/projection";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { FinanceSource } from "./contract";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const currency = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
const currencies = (value: RecordValue | null | undefined): string[] => value ? [value.currency, value.iso_currency_code, value.unofficial_currency_code].map(currency).filter((item): item is string => Boolean(item)) : [];

function assertLinkedAdvisorSource(financial: RecordValue, portfolio: PortfolioData): void {
  const holdings = record(financial.holdings_v1);
  const accounts = record(financial.accounts_v1) || {};
  const securities = record(financial.securities_v1) || {};
  const rows = portfolio.holdings || [];
  if (!holdings || Object.keys(holdings).length !== rows.length || rows.length > 100) {
    throw new Error("The linked portfolio cannot be shared completely. Check for duplicate or unavailable positions.");
  }
  const seen = new Set<string>();
  for (const position of rows) {
    const match = Object.entries(holdings).find(([, value]) => {
      const holding = record(value);
      return holding && holding.account_id === position.account_id && holding.security_id === position.security_id && holding.item_id === position.item_id;
    });
    const holding = record(match?.[1]);
    const account = Object.values(accounts).map(record).find(item => item?.account_id === holding?.account_id && item?.item_id === holding?.item_id);
    const balances = record(account?.balances);
    const unit = currency(holding?.iso_currency_code);
    const security = record(securities[String(holding?.security_id || "")]);
    const units = [...currencies(holding), ...currencies(account), ...currencies(balances), ...currencies(security)];
    if (!match || seen.has(match[0]) || !holding || !account || unit !== "USD" || units.some(item => item !== "USD")
      || typeof holding.quantity !== "number" || !Number.isFinite(holding.quantity) || holding.quantity <= 0
      || typeof holding.institution_value !== "number" || !Number.isFinite(holding.institution_value) || holding.institution_value <= 0
      || holding.quantity !== position.quantity || holding.institution_value !== position.market_value
      || typeof position.price !== "number" || !Number.isFinite(position.price) || position.price <= 0) {
      throw new Error("The linked source has positions or currency information that cannot be verified accurately for advisor review.");
    }
    seen.add(match[0]);
  }
}

/** Check the selected saved source before its normalizer can drop or invent values. */
export function assertAdvisorSourceIntegrity(financial: RecordValue, source: FinanceSource, portfolio: PortfolioData): void {
  const connections = record(financial.connections_v1);
  const linkedPortfolio = source.kind === "plaid" && connections && Object.keys(connections).length ? toVaultPortfolioData(financial) : null;
  if (linkedPortfolio?.holdings?.length) {
    assertLinkedAdvisorSource(financial, portfolio);
    return;
  }
  let raw: RecordValue | null = null;
  let entries: unknown = null;
  let accountCurrencies: string[] = [];
  let positionCurrencies: string[][] = [];
  if (source.representation === "current-v7") {
    raw = record(financial.financial_core_v7);
    const positions = record(raw?.positions);
    const securities = record(raw?.securities) || {};
    const accounts = record(raw?.accounts) || {};
    accountCurrencies = Object.values(accounts).flatMap(value => {
      const account = record(value);
      return [...currencies(account), ...currencies(record(account?.balances))];
    });
    if (!positions) throw new Error("The selected source's positions cannot be verified for advisor review.");
    entries = Object.values(positions).map(value => {
      const position = record(value) || {};
      const security = record(securities[String(position.security_id || "")]) || {};
      const account = record(accounts[String(position.account_id || "")]) || Object.values(accounts).map(record).find(item => item?.account_id === position.account_id);
      positionCurrencies.push([...currencies(position), ...currencies(security), ...currencies(account), ...currencies(record(account?.balances))]);
      return { ...security, ...position, symbol: security.symbol || position.symbol };
    });
  } else if (source.snapshotId) {
    const snapshot = getStatementSnapshots(financial).find(item => item.id === source.snapshotId);
    const outer = record(snapshot);
    accountCurrencies = [...currencies(outer), ...currencies(record(outer?.account_info)), ...currencies(record(outer?.account_summary)), ...currencies(record(outer?.source))];
    raw = record(snapshot?.canonical_v2) || record(snapshot);
    entries = raw?.holdings;
  } else {
    if (getStatementSnapshots(financial).length) throw new Error("The selected source cannot be verified for advisor review.");
    raw = record(financial.portfolio);
    entries = raw?.holdings;
  }
  if (!raw || !Array.isArray(entries)) throw new Error("The selected source's positions cannot be verified for advisor review.");
  const normalized = portfolio.holdings || [];
  if (entries.length !== normalized.length || entries.length > 100) throw new Error("The selected source cannot be shared completely. Check its positions before advisor review.");
  const account = record(raw.account_info) || {};
  const summary = record(raw.account_summary) || {};
  const sourceCurrencies = [...currencies(raw), ...currencies(account), ...currencies(summary)];
  const rowCurrencies: string[] = [];
  for (const [index, value] of entries.entries()) {
    const row = record(value);
    const price = row?.price ?? row?.price_per_unit;
    const projected = normalized[index];
    if (!row || !projected || !String(row.symbol || "").trim() || typeof row.market_value !== "number" || !Number.isFinite(row.market_value)
      || typeof row.quantity !== "number" || !Number.isFinite(row.quantity) || typeof price !== "number" || !Number.isFinite(price)
      || projected.market_value !== row.market_value || projected.quantity !== row.quantity || projected.price !== price
      || [row.cost_basis, row.unrealized_gain_loss, row.unrealized_gain_loss_pct].some(item => item != null && (typeof item !== "number" || !Number.isFinite(item)))
      || (row.cost_basis != null && projected.cost_basis !== row.cost_basis)
      || (row.unrealized_gain_loss != null && projected.unrealized_gain_loss !== row.unrealized_gain_loss)
      || (row.unrealized_gain_loss_pct != null && projected.unrealized_gain_loss_pct !== row.unrealized_gain_loss_pct)
      || projected.symbol !== String(row.symbol).trim().toUpperCase()) {
      throw new Error("The selected source has positions that cannot be verified accurately for advisor review.");
    }
    const explicit = [...currencies(row), ...(positionCurrencies[index] || [])];
    if (explicit.length) rowCurrencies.push(...explicit);
    else if (source.representation === "current-v7" || !sourceCurrencies.length) throw new Error("The selected source does not identify every position's currency.");
  }
  const allCurrencies = [...sourceCurrencies, ...accountCurrencies, ...rowCurrencies];
  if (!allCurrencies.length || allCurrencies.some(item => item !== "USD")) throw new Error("Advisor review currently supports explicitly identified USD portfolios only.");
}
