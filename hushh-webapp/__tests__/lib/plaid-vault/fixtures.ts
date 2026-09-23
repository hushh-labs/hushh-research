/**
 * Fixtures modelled on Plaid SANDBOX responses.
 *
 * First Platypus Bank (ins_109508) returns 14 accounts, 13 investment holdings
 * and a transactions page; Platypus OAuth Bank (ins_127287) returns checking
 * and savings. Account ids are prefixed per item so the same bank can be
 * linked twice, exactly as Plaid issues new account_ids per item.
 */

import type {
  PlaidAccount,
  PlaidHolding,
  PlaidSecurity,
  PlaidTx,
  PlaidVaultSnapshot,
} from "@/lib/kai/plaid-vault/types";

export const NOW = "2026-09-23T12:00:00.000Z";

export const FIRST_PLATYPUS = { id: "ins_109508", name: "First Platypus Bank" };
export const PLATYPUS_OAUTH = { id: "ins_127287", name: "Platypus OAuth Bank" };

type AccountSeed = [suffix: string, name: string, mask: string, type: string, subtype: string, current: number, available?: number | null, limit?: number | null];

const FIRST_PLATYPUS_ACCOUNTS: AccountSeed[] = [
  ["chk", "Plaid Checking", "0000", "depository", "checking", 110, 100],
  ["sav", "Plaid Saving", "1111", "depository", "savings", 210, 200],
  ["cd", "Plaid CD", "2222", "depository", "cd", 1000, null],
  ["cc", "Plaid Credit Card", "3333", "credit", "credit card", 410, null, 2000],
  ["mm", "Plaid Money Market", "4444", "depository", "money market", 43200, 43200],
  ["ira", "Plaid IRA", "5555", "investment", "ira", 320.76, null],
  ["401k", "Plaid 401k", "6666", "investment", "401k", 23631.98, null],
  ["stu", "Plaid Student Loan", "7777", "loan", "student", 65262, null],
  ["mtg", "Plaid Mortgage", "8888", "loan", "mortgage", 56302.06, null],
  ["hsa", "Plaid HSA", "9001", "depository", "hsa", 6009, 6009],
  ["cm", "Plaid Cash Management", "9002", "depository", "cash management", 12060, 12060],
  ["auto", "Plaid Auto Loan", "9003", "loan", "auto", 23211.33, null],
  ["heloc", "Plaid Home Equity Line of Credit", "9004", "loan", "home equity", 13500.5, null],
  ["bcc", "Plaid Business Credit Card", "9999", "credit", "credit card", 5020, null, 10000],
];

/** Expected First Platypus totals, straight from the balances above. */
export const FIRST_PLATYPUS_TOTALS = {
  assets: 86541.74,
  liabilities: 163705.89,
  netWorth: -77164.15,
  liquid: 61589,
  investable: 23952.74,
};

function seedAccounts(prefix: string, seeds: AccountSeed[]): PlaidAccount[] {
  return seeds.map(([suffix, name, mask, type, subtype, current, available, limit]) => ({
    account_id: `${prefix}_${suffix}`,
    persistent_account_id: null,
    name,
    official_name: `${name} Official ${mask}`,
    mask,
    type,
    subtype,
    balances: {
      available: available ?? null,
      current,
      limit: limit ?? null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
  }));
}

export const FIRST_PLATYPUS_SECURITIES: PlaidSecurity[] = [
  { security_id: "sec_achn", ticker_symbol: "ACHN", name: "Achillion Pharmaceuticals Inc.", type: "equity", cusip: "00448Q201", close_price: 2.1 },
  { security_id: "sec_camyx", ticker_symbol: "CAMYX", name: "Cambiar International Equity Institutional", type: "mutual fund", cusip: "74316P207", close_price: 23.79 },
  { security_id: "sec_dblfx", ticker_symbol: "DBLFX", name: "DoubleLine Core Fixed Income Fund I", type: "mutual fund", cusip: "258620301", close_price: 10.42 },
  { security_id: "sec_nhx", ticker_symbol: null, name: "NH Portsmouth Rev Bond 5.00% 2028", type: "fixed income", cusip: "NHX105509", close_price: 94.34 },
  { security_id: "sec_nflx_put", ticker_symbol: "NFLX220121P00400000", name: "Nflx Jan 21 2022 400 Put", type: "derivative", cusip: null, close_price: 16.3 },
  { security_id: "sec_miptx", ticker_symbol: "MIPTX", name: "Matthews Pacific Tiger Fund Insti Class", type: "mutual fund", cusip: "577130834", close_price: 27.0 },
  { security_id: "sec_sbsi", ticker_symbol: "SBSI", name: "Southside Bancshares Inc.", type: "equity", cusip: "84470P109", close_price: 34.8 },
  { security_id: "sec_prfdx", ticker_symbol: "PRFDX", name: "T. Rowe Price Equity Income", type: "mutual fund", cusip: "779547108", close_price: 35.27 },
  { security_id: "sec_ewz", ticker_symbol: "EWZ", name: "iShares Inc MSCI Brazil", type: "etf", cusip: "464286400", close_price: 34.73 },
  { security_id: "sec_usd", ticker_symbol: "CUR:USD", name: "U S Dollar", type: "cash", cusip: null, is_cash_equivalent: true, close_price: 1 },
  { security_id: "sec_btc", ticker_symbol: "CUR:BTC", name: "Bitcoin", type: "cryptocurrency", cusip: null, close_price: 10000 },
  { security_id: "sec_tbill", ticker_symbol: null, name: "US Treasury Bill - 0.43% 31/12/2026", type: "fixed income", cusip: "912797HC4", close_price: 99.2 },
  { security_id: "sec_voo", ticker_symbol: "VOO", name: "Vanguard S&P 500 ETF", type: "etf", cusip: "922908363", close_price: 410.12 },
];

type HoldingSeed = [accountSuffix: string, securityId: string, quantity: number, value: number, costBasis: number | null];

const FIRST_PLATYPUS_HOLDINGS: HoldingSeed[] = [
  ["ira", "sec_achn", 10, 21, 30],
  ["ira", "sec_usd", 299.76, 299.76, 299.76],
  ["401k", "sec_camyx", 100, 2379, 2000],
  ["401k", "sec_dblfx", 200, 2084, 2100],
  ["401k", "sec_nhx", 10, 943.4, 1000],
  ["401k", "sec_nflx_put", 1, 16.3, 20],
  ["401k", "sec_miptx", 100, 2700, 2500],
  ["401k", "sec_sbsi", 50, 1740, 1500],
  ["401k", "sec_prfdx", 100, 3527, 3000],
  ["401k", "sec_ewz", 60, 2083.8, 2400],
  ["401k", "sec_btc", 0.2, 2000, 1500],
  ["401k", "sec_tbill", 20, 1984, 1990],
  ["401k", "sec_voo", 10, 4101.2, 3500],
];

function seedHoldings(prefix: string): PlaidHolding[] {
  const prices = new Map(FIRST_PLATYPUS_SECURITIES.map((s) => [s.security_id, s.close_price ?? 0]));
  return FIRST_PLATYPUS_HOLDINGS.map(([suffix, securityId, quantity, value, costBasis]) => ({
    account_id: `${prefix}_${suffix}`,
    security_id: securityId,
    quantity,
    institution_price: prices.get(securityId) ?? null,
    institution_price_as_of: "2026-09-22",
    institution_value: value,
    cost_basis: costBasis,
    iso_currency_code: "USD",
  }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date for `monthsBack` months before September 2026, on `day`. */
function dateFor(monthsBack: number, day: number): string {
  const d = new Date(Date.UTC(2026, 8 - monthsBack, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(day)}`;
}

function tx(
  prefix: string,
  id: string,
  accountSuffix: string,
  date: string,
  amount: number,
  name: string,
  merchant: string | null,
  primary: string,
  detailed: string,
  extras: Partial<PlaidTx> = {}
): PlaidTx {
  return {
    transaction_id: `${prefix}_tx_${id}`,
    account_id: `${prefix}_${accountSuffix}`,
    amount,
    iso_currency_code: "USD",
    date,
    authorized_date: date,
    name,
    merchant_name: merchant,
    merchant_entity_id: merchant ? `ent_${merchant.toLowerCase().replace(/\W+/g, "")}` : null,
    pending: false,
    payment_channel: "online",
    personal_finance_category: { primary, detailed, confidence_level: "VERY_HIGH" },
    category: null,
    location: null,
    counterparties: merchant ? [{ name: merchant, type: "merchant", entity_id: "ent_x", website: "example.com" }] : [],
    logo_url: null,
    website: null,
    ...extras,
  };
}

/**
 * 26 months of activity ending 2026-09-22: payroll twice a month, a monthly
 * streaming bill, a monthly mortgage payment, a card payment (excluded from
 * cash flow on both sides), groceries with a store location, and a savings
 * transfer (excluded).
 */
export function firstPlatypusTransactions(prefix: string): PlaidTx[] {
  const rows: PlaidTx[] = [];
  let grocery = 0;
  for (let m = 25; m >= 0; m -= 1) {
    const days = (day: number) => m > 0 || day <= 22;
    if (days(1)) rows.push(tx(prefix, `pay1_${m}`, "chk", dateFor(m, 1), -2500, "GUSTO PAY 123456", "Gusto", "INCOME", "INCOME_WAGES"));
    if (days(15)) rows.push(tx(prefix, `pay15_${m}`, "chk", dateFor(m, 15), -2500, "GUSTO PAY 123456", "Gusto", "INCOME", "INCOME_WAGES"));
    if (days(3)) rows.push(tx(prefix, `mtg_${m}`, "chk", dateFor(m, 3), 1200, "PLATYPUS MORTGAGE PMT", "Platypus Mortgage Co", "LOAN_PAYMENTS", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"));
    if (days(5)) rows.push(tx(prefix, `nflx_${m}`, "cc", dateFor(m, 5), 15.49, "NETFLIX.COM", "Netflix", "ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES"));
    if (days(10)) {
      rows.push(tx(prefix, `ccpay_out_${m}`, "chk", dateFor(m, 10), 500, "CREDIT CARD PAYMENT", null, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"));
      rows.push(tx(prefix, `ccpay_in_${m}`, "cc", dateFor(m, 10), -500, "PAYMENT THANK YOU", null, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"));
    }
    if (days(20)) rows.push(tx(prefix, `xfer_${m}`, "chk", dateFor(m, 20), 300, "TRANSFER TO SAVINGS", null, "TRANSFER_OUT", "TRANSFER_OUT_SAVINGS"));
    for (const day of [8, 12, 18, 26]) {
      if (!days(day)) continue;
      grocery += 1;
      rows.push(
        tx(prefix, `groc_${m}_${day}`, "cc", dateFor(m, day), 50 + grocery + 0.25, "WHOLE FOODS #1234", "Whole Foods", "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES", {
          location: { address: "399 4th St", city: "San Francisco", region: "CA", postal_code: "94107", country: "US", lat: 37.78, lon: -122.4, store_number: "1234" },
          payment_channel: "in store",
        })
      );
    }
  }
  return rows;
}

export function firstPlatypusSnapshot(itemId: string, prefix: string): PlaidVaultSnapshot {
  return {
    item: {
      item_id: itemId,
      institution_id: FIRST_PLATYPUS.id,
      products: ["investments", "transactions"],
      consented_products: ["investments", "transactions"],
      error: null,
    },
    accounts: seedAccounts(prefix, FIRST_PLATYPUS_ACCOUNTS),
    investments: { holdings: seedHoldings(prefix), securities: FIRST_PLATYPUS_SECURITIES },
    transactions: {
      added: firstPlatypusTransactions(prefix),
      modified: [],
      removed: [],
      next_cursor: `${prefix}-cursor-page-1`,
      pages: 3,
    },
  };
}

/** A second sync page: one grocery amount corrected, one removed, one new charge. */
export function firstPlatypusSecondPage(itemId: string, prefix: string): PlaidVaultSnapshot {
  const base = firstPlatypusSnapshot(itemId, prefix);
  const all = firstPlatypusTransactions(prefix);
  const modifiedSource = all.find((row) => row.transaction_id === `${prefix}_tx_groc_0_18`)!;
  return {
    ...base,
    transactions: {
      added: [
        tx(prefix, "new_coffee", "cc", "2026-09-22", 6.75, "BLUE BOTTLE COFFEE", "Blue Bottle Coffee", "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"),
      ],
      modified: [{ ...modifiedSource, amount: 99.99 }],
      removed: [{ transaction_id: `${prefix}_tx_groc_0_12` }],
      next_cursor: `${prefix}-cursor-page-2`,
      pages: 1,
    },
  };
}

export function platypusOauthSnapshot(itemId: string): PlaidVaultSnapshot {
  return {
    item: {
      item_id: itemId,
      institution_id: PLATYPUS_OAUTH.id,
      products: ["transactions"],
      consented_products: ["transactions"],
      error: null,
    },
    accounts: seedAccounts("oauth", [
      ["chk", "Plaid Checking", "0000", "depository", "checking", 110, 100],
      ["sav", "Plaid Saving", "1111", "depository", "savings", 210, 200],
    ]),
    investments: { unavailable: "PRODUCTS_NOT_SUPPORTED" },
    transactions: {
      added: [
        tx("oauth", "coffee", "chk", "2026-09-20", 4.5, "STARBUCKS", "Starbucks", "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"),
      ],
      modified: [],
      removed: [],
      next_cursor: "oauth-cursor-1",
      pages: 1,
    },
  };
}

/** A small synthetic institution with the given accounts and no transactions product. */
export function smallInstitutionSnapshot(
  itemId: string,
  institutionId: string,
  prefix: string,
  seeds: AccountSeed[]
): PlaidVaultSnapshot {
  return {
    item: {
      item_id: itemId,
      institution_id: institutionId,
      products: ["auth"],
      consented_products: ["auth"],
      error: null,
    },
    accounts: seedAccounts(prefix, seeds),
    investments: { unavailable: "PRODUCTS_NOT_SUPPORTED" },
    transactions: { unavailable: "PRODUCT_NOT_READY" },
  };
}

export const TARTAN = { id: "ins_109511", name: "Tartan Bank" };
export const HOUNDSTOOTH = { id: "ins_109512", name: "Houndstooth Bank" };
export const GINGHAM = { id: "ins_109509", name: "First Gingham Credit Union" };

export const TARTAN_ACCOUNTS: AccountSeed[] = [
  ["chk", "Tartan Everyday Checking", "4321", "depository", "checking", 2450.12, 2400],
  ["cc", "Tartan Rewards Card", "8765", "credit", "credit card", 312.4, null, 5000],
];
export const HOUNDSTOOTH_ACCOUNTS: AccountSeed[] = [
  ["sav", "Houndstooth High Yield Savings", "2468", "depository", "savings", 15000, 15000],
];
export const GINGHAM_ACCOUNTS: AccountSeed[] = [
  ["auto", "Gingham Auto Loan", "1357", "loan", "auto", 8420.55, null],
];
