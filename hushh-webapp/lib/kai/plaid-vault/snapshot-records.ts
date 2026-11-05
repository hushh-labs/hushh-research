import type {
  AccountRecord, ConnectionRecord, HoldingRecord, PlaidAccount,
  PlaidHolding, PlaidSecurity, PlaidTx, SecurityRecord, TransactionRecord,
} from "./types";

export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function toAccountRecord(
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
      unofficial_currency_code: cleanText(account.balances?.unofficial_currency_code),
    },
    duplicate_of: null,
  };
}

export function toSecurityRecord(security: PlaidSecurity): SecurityRecord {
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

export function toHoldingRecord(
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
    nws_value: toNumber(holding.institution_value),
    unofficial_currency_code: cleanText(holding.unofficial_currency_code),
    cost_basis: toNumber(holding.cost_basis),
    iso_currency_code: cleanText(holding.iso_currency_code),
  };
}

export function toTransactionRecord(itemId: string, tx: PlaidTx): TransactionRecord {
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
    nws_amount: toNumber(tx.amount),
    unofficial_currency_code: cleanText(tx.unofficial_currency_code),
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
