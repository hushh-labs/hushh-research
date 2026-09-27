import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";

type AnyObj = Record<string, unknown>;

/** Statement snapshots kept in `documents.statements`, newest first. */
export const STATEMENT_SNAPSHOT_LIMIT = 25;

function asRecord(value: unknown): AnyObj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyObj)
    : {};
}

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function accountNumber(value: unknown): string {
  return text(value).replace(/[\s-]/g, "");
}

function rounded(value: unknown, digits: number): string {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "";
}

function holdingsFingerprint(holdings: unknown): string[] {
  if (!Array.isArray(holdings)) return [];
  return holdings
    .map((raw) => {
      const holding = asRecord(raw);
      return [
        text(holding.symbol).toUpperCase(),
        text(holding.name),
        rounded(holding.quantity, 6),
        rounded(holding.market_value, 2),
      ].join("|");
    })
    .sort();
}

/**
 * A stable id for one brokerage statement, so saving the same statement again
 * (a double tap, a retry after a timeout, a remounted review, or the setup
 * draft and the review both committing it) replaces its snapshot instead of
 * adding a second one.
 *
 * A statement is identified by its brokerage, account and period. When the
 * parser could not read the account number or the period end, the holdings
 * join the identity so two unlabeled statements never collapse into one.
 */
export async function computeStatementImportId(portfolio: AnyObj): Promise<string> {
  const accountInfo = asRecord(portfolio.account_info);
  const identity = {
    brokerage: text(accountInfo.brokerage ?? accountInfo.brokerage_name),
    account_number: accountNumber(accountInfo.account_number),
    account_type: text(accountInfo.account_type),
    period_start: text(accountInfo.statement_period_start),
    period_end: text(accountInfo.statement_period_end),
  };
  const isLabeled = Boolean(identity.account_number && identity.period_end);
  const payload = isLabeled
    ? { v: 1, ...identity }
    : { v: 1, ...identity, holdings: holdingsFingerprint(portfolio.holdings) };
  const digest = await sha256Hex(JSON.stringify(payload));
  return `stmt_${digest.slice(0, 24)}`;
}

/** Puts `snapshot` first, dropping any earlier snapshot with the same id. */
export function upsertStatementSnapshot(
  existing: unknown,
  snapshot: AnyObj,
  limit: number = STATEMENT_SNAPSHOT_LIMIT,
): AnyObj[] {
  const snapshotId = String(snapshot.id ?? "");
  const others = (Array.isArray(existing) ? existing : [])
    .map(asRecord)
    .filter((entry) => String(entry.id ?? "") !== snapshotId);
  return [snapshot, ...others].slice(0, limit);
}
