import { computePlaidNwsV1, type NwsCoverageReason, type NwsReport } from "./nws-score";
import type { FinancialDomain } from "./types";

const accountKey = (itemId: string, accountId: string) => `${itemId}:${accountId}`;

/** Owner-only projection. The encrypted financial domain owns the input revision. */
export function readFinancialNws(financial: FinancialDomain | null | undefined): NwsReport | null {
  if (!financial) return null;
  const connections = financial.connections_v1 ?? {};
  const latest = Object.values(connections)
    .flatMap(connection => connection.last_refreshed_at ? [connection.last_refreshed_at] : [])
    .sort().at(-1);
  if (!latest) return null;

  const holdings = new Map<string, { value: number | null; currency: string | null }[]>();
  for (const holding of Object.values(financial.holdings_v1 ?? {})) {
    const key = accountKey(holding.item_id, holding.account_id);
    const rows = holdings.get(key) ?? [];
    rows.push({
      value: holding.nws_value ?? null,
      currency: holding.iso_currency_code ?? holding.unofficial_currency_code ?? null,
    });
    holdings.set(key, rows);
  }

  const accounts = Object.values(financial.accounts_v1 ?? {}).filter(
    account => !account.duplicate_of && connections[account.item_id],
  );
  const historyItems = new Set(accounts.filter(account =>
    ["depository", "credit", "loan"].includes(account.type),
  ).map(account => account.item_id));
  const productCoverage = new Set<NwsCoverageReason>();
  for (const account of accounts) {
    const connection = connections[account.item_id];
    if (!connection) continue;
    const investment = ["investment", "brokerage"].includes(account.type);
    const revolving = account.type === "credit" && (account.balances.current ?? 0) > 0;
    if (!investment && !revolving) continue;
    const product = investment ? "investments" : "liabilities";
    const supported = investment ? connection.nws_investments_available : connection.nws_debt_details_available;
    if (supported === false) productCoverage.add("product_unsupported");
    if (supported === true && !connection.products.includes(product) &&
        connection.nws_consent && !connection.nws_consent.includes(product)) {
      productCoverage.add("product_consent_missing");
    }
  }
  return computePlaidNwsV1({
    asOfTimestamp: latest,
    coverageReasons: [...productCoverage],
    historyComplete: historyItems.size > 0 &&
      [...historyItems].every(item => connections[item]?.nws_history_complete === true),
    accounts: accounts.map(account => {
      const key = accountKey(account.item_id, account.account_id);
      const connection = connections[account.item_id];
      return {
        key,
        type: account.type,
        currency: account.balances.iso_currency_code ?? account.balances.unofficial_currency_code,
        current: account.balances.current,
        available: account.balances.available,
        limit: account.balances.limit,
        holdings: connection?.nws_holdings_complete ? holdings.get(key) ?? [] : null,
        apr: connection?.nws_credit_apr?.[account.account_id] ?? null,
      };
    }),
    transactions: Object.values(financial.transactions_v1 ?? {}).map(tx => ({
      accountKey: accountKey(tx.item_id, tx.account_id),
      currency: tx.iso_currency_code ?? tx.unofficial_currency_code,
      date: tx.date,
      // Older revisions mapped malformed amounts to zero. Only new
      // projections can distinguish that from a verified zero.
      amount: tx.nws_amount !== undefined ? tx.nws_amount : tx.amount === 0 ? null : tx.amount,
      pending: tx.pending,
      primary: tx.category_primary,
      detailed: tx.category_detailed,
    })),
  });
}
