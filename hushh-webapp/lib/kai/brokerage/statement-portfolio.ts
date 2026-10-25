import type { PortfolioData } from "@/components/kai/types/portfolio";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only enrich from the selected statement; never borrow another account's dates. */
export function normalizeStatementPortfolio(candidate: Record<string, unknown>, snapshot: Record<string, unknown> | null): PortfolioData {
  const source = record(snapshot?.source);
  const account = { ...record(snapshot?.account_info), ...record(candidate.account_info) };
  const period = record(account.statement_period);
  return normalizeStoredPortfolio({ ...candidate, account_info: {
    ...account,
    brokerage_name: account.brokerage_name ?? account.brokerage ?? source.brokerage,
    statement_period_start: account.statement_period_start ?? source.statement_period_start ?? period.start,
    statement_period_end: account.statement_period_end ?? source.statement_period_end ?? period.end,
  }, historical_values: candidate.historical_values ?? snapshot?.historical_values ?? record(snapshot?.raw_extract_v2).historical_values }) as PortfolioData;
}
