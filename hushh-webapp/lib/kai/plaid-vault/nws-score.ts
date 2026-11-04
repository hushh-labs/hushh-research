export const NWS_POLICY_VERSION = "plaid-nws-v1" as const;

type Currency = string | null | undefined;

export interface NwsAccount {
  key: string;
  type: string;
  liquidCash: boolean;
  currency: Currency;
  current: number | null;
  available: number | null;
  limit: number | null;
  holdings: { value: number | null; currency: Currency }[] | null;
  apr: number | null;
}

export interface NwsTransaction {
  accountKey: string;
  currency: Currency;
  date: string;
  amount: number | null;
  pending: boolean;
  primary: string | null;
  detailed: string | null;
}

export type NwsCoverageReason =
  | "no_usable_usd_balance_evidence"
  | "currency_unavailable"
  | "balance_unavailable"
  | "holdings_unavailable"
  | "history_incomplete"
  | "transaction_data_incomplete"
  | "cash_only_coverage"
  | "debt_details_unavailable"
  | "product_consent_missing"
  | "product_unsupported";

export interface NwsScoreInput {
  accounts: NwsAccount[];
  transactions: NwsTransaction[];
  historyComplete: boolean;
  coverageReasons?: NwsCoverageReason[];
  asOfTimestamp: string;
}

const WEIGHTS = {
  solvency: 300,
  liquidity_runway: 250,
  debt_and_credit: 200,
  savings_rate: 150,
  investment_mix: 100,
} as const;

export interface NwsReport {
  policyVersion: typeof NWS_POLICY_VERSION;
  score: number | null;
  netWorth: number | null;
  history: "unavailable" | "provisional" | "historical";
  asOfTimestamp: string;
  activeWeight: number;
  completenessMultiplier: number | null;
  coverageReasons: NwsCoverageReason[];
  factors: {
    factor: keyof typeof WEIGHTS;
    baseWeight: number;
    normalizedScore: number | null;
    pointsContributed: number;
  }[];
}

const DAY = 86_400_000;
const INVESTMENT_TYPES = new Set(["investment", "brokerage"]);
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const usd = (value: Currency, parent?: Currency) => (value ?? parent) === "USD";

function utcDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(date);
  if (!finite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
  return timestamp / DAY;
}

function measureCashFlow(input: NwsScoreInput, accounts: Map<string, NwsAccount>, reasons: Set<NwsCoverageReason>) {
  const asOf = Date.parse(input.asOfTimestamp);
  if (!finite(asOf)) return null;
  const end = Math.floor(asOf / DAY);

  let first = end;
  let last = end - 90;
  let inflow = 0;
  let outflow = 0;
  for (const tx of input.transactions) {
    const account = accounts.get(tx.accountKey);
    if (!account || tx.pending || tx.primary?.startsWith("TRANSFER_") ||
        tx.detailed?.includes("CREDIT_CARD_PAYMENT") || tx.detailed?.includes("ACCOUNT_TRANSFER")) continue;
    const day = utcDay(tx.date);
    if (day !== null && (day >= end || day < end - 90)) continue;
    if (day === null || !finite(tx.amount) || !usd(tx.currency, account.currency)) {
      reasons.add("transaction_data_incomplete");
      continue;
    }
    first = Math.min(first, day);
    last = Math.max(last, day);
    if (tx.amount > 0) outflow += tx.amount;
    else inflow -= tx.amount;
  }

  if (!Number.isFinite(inflow) || !Number.isFinite(outflow)) reasons.add("transaction_data_incomplete");
  const span = last - first + 1;
  if (!input.historyComplete) reasons.add("history_incomplete");
  if (reasons.has("transaction_data_incomplete") || (!input.historyComplete && span < 21)) return null;

  const months = (input.historyComplete ? 90 : span) / 30.4375;
  return { inflow: inflow / months, outflow: outflow / months };
}

export function computePlaidNwsV1(input: NwsScoreInput): NwsReport {
  const reasons = new Set<NwsCoverageReason>(input.coverageReasons);
  const accounts = new Map<string, NwsAccount>();
  let liquid = 0;
  let depositoryAssets = 0;
  let investment = 0;
  let overdraft = 0;
  let credit = 0;
  let loan = 0;
  let knownLimit = 0;
  let matchedDebt = 0;
  let hasDebtAccount = false;
  let hasInvestmentAccount = false;
  let hasInvestmentEvidence = false;
  let highApr = false;
  let usable = false;

  for (const account of input.accounts) {
    if (accounts.has(account.key)) continue;
    accounts.set(account.key, account);
    if (INVESTMENT_TYPES.has(account.type)) {
      hasInvestmentAccount = true;
      const holdings = account.holdings;
      if ((account.currency || holdings?.length === 0) && !usd(account.currency)) {
        reasons.add("currency_unavailable");
        continue;
      }
      if (holdings === null || holdings.some(row => !usd(row.currency, account.currency) || !finite(row.value))) {
        reasons.add("holdings_unavailable");
        continue;
      }
      const value = holdings.length === 0 ? account.current : holdings.reduce((sum, row) => sum + (row.value ?? 0), 0);
      if (!finite(value)) {
        reasons.add("balance_unavailable");
        continue;
      }
      investment += Math.max(0, value);
      loan += Math.max(0, -value);
      hasInvestmentEvidence = true;
      usable = true;
      continue;
    }
    if (!["depository", "credit", "loan"].includes(account.type)) continue;
    if (!usd(account.currency)) {
      reasons.add("currency_unavailable");
      continue;
    }
    const balance = account.current ?? (account.type === "depository" ? account.available : null);
    if (!finite(balance)) {
      reasons.add("balance_unavailable");
      continue;
    }

    usable = true;
    if (account.type === "depository") {
      const deposit = Math.max(0, balance);
      depositoryAssets += deposit;
      if (account.liquidCash) liquid += deposit;
      overdraft += Math.max(0, -balance);
    } else {
      hasDebtAccount = true;
      const debt = Math.max(0, balance);
      if (account.type === "loan") {
        loan += debt;
      } else {
        credit += debt;
        if (finite(account.limit) && account.limit > 0) {
          matchedDebt += debt;
          knownLimit += account.limit;
        }
        if (debt > 0 && !finite(account.apr)) reasons.add("debt_details_unavailable");
        if (debt > 0 && finite(account.apr) && account.apr > 20) highApr = true;
      }
    }
  }

  const report: NwsReport = {
    policyVersion: NWS_POLICY_VERSION,
    score: null,
    netWorth: null,
    history: "unavailable",
    asOfTimestamp: input.asOfTimestamp,
    activeWeight: 0,
    completenessMultiplier: null,
    coverageReasons: [],
    factors: [],
  };
  if (!usable) {
    reasons.add("no_usable_usd_balance_evidence");
    return { ...report, coverageReasons: [...reasons] };
  }

  const assets = depositoryAssets + investment;
  const debt = credit + loan + overdraft;
  if (!Number.isSafeInteger(Math.round(assets * 100)) || !Number.isSafeInteger(Math.round(debt * 100))) {
    reasons.add("balance_unavailable");
    return { ...report, coverageReasons: [...reasons] };
  }
  const flow = measureCashFlow(input, accounts, reasons);
  const debtCap = debt > 0 ? assets / (assets + debt) : 1;
  const revolving = knownLimit > 0 && matchedDebt === credit ? clamp(1 - (matchedDebt / knownLimit) ** 1.2) : debtCap;
  const debtFactor = loan > 0 ? Math.min(revolving, (revolving + debtCap) / 2) : revolving;
  const cashOnly = !hasInvestmentAccount && liquid > 15_000;
  if (cashOnly) reasons.add("cash_only_coverage");
  const values: Record<keyof typeof WEIGHTS, number | null> = {
    solvency: assets + debt === 0 ? 0.5 : assets / (assets + 1.5 * debt),
    liquidity_runway: !flow ? null : flow.outflow === 0
      ? (liquid > 0 ? 1 : 0.5) : 1 - Math.exp(-0.35 * liquid / flow.outflow),
    debt_and_credit: hasDebtAccount || debt > 0 ? clamp(debtFactor - (highApr ? 0.10 : 0)) : null,
    savings_rate: !flow ? null : flow.inflow === 0
      ? (flow.outflow === 0 ? 0.5 : liquid > 6 * flow.outflow ? 0.25 : 0)
      : clamp(((flow.inflow - flow.outflow) / flow.inflow + 0.10) / 0.35),
    investment_mix: hasInvestmentEvidence ? (assets > 0 ? clamp(investment / (0.5 * assets)) : 0)
      : cashOnly ? 0.15 : null,
  };
  const keys = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];
  const activeWeight = keys.reduce((sum, key) => sum + (values[key] === null ? 0 : WEIGHTS[key]), 0);
  const multiplier = 0.85 + 0.15 * activeWeight / 1000;
  const factors = keys.map(factor => ({
    factor,
    baseWeight: WEIGHTS[factor],
    normalizedScore: values[factor],
    pointsContributed: 1000 * WEIGHTS[factor] * (values[factor] ?? 0) * multiplier / activeWeight,
  }));
  return {
    ...report,
    netWorth: Math.round((assets - debt) * 100) / 100,
    score: Math.round(factors.reduce((sum, factor) => sum + factor.pointsContributed, 0)),
    history: flow ? (input.historyComplete ? "historical" : "provisional") : "unavailable",
    activeWeight,
    completenessMultiplier: multiplier,
    coverageReasons: [...reasons],
    factors,
  };
}
