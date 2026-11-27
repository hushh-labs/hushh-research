import { formatRelativeTime } from "@/lib/format/relative-time";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { PortfolioSource, StatementSnapshotOption } from "@/lib/kai/brokerage/portfolio-sources";

export type PortfolioImportLabel = "PDF" | "CSV" | "Plaid" | "Statement";

export function portfolioImportLabel(
  source: PortfolioSource,
  snapshots: readonly StatementSnapshotOption[],
  activeSnapshotId: string | null,
): PortfolioImportLabel {
  if (source === "plaid") return "Plaid";
  const fileName = snapshots.find(snapshot => snapshot.id === activeSnapshotId)?.fileName;
  const extension = fileName?.trim().match(/\.(pdf|csv)$/i)?.[1]?.toLowerCase();
  if (extension === "pdf") return "PDF";
  if (extension === "csv") return "CSV";
  return "Statement";
}

const portfolioDateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const portfolioCalendarDateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function formatPortfolioDate(value: string | null | undefined, isStatementEnd = false): string | null {
  const text = value?.trim();
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  const isCalendarDate = calendarDatePattern.test(text);
  if (isCalendarDate && date.toISOString().slice(0, 10) !== text) return null;
  return (isStatementEnd || isCalendarDate ? portfolioCalendarDateFormat : portfolioDateFormat).format(date);
}

export function formatStatementBalanceDate(
  snapshot: Pick<StatementSnapshotOption, "statementPeriodEnd" | "importedAt"> | undefined,
  statementEnd?: string | null,
): string {
  const through = formatPortfolioDate(snapshot?.statementPeriodEnd, true) ?? formatPortfolioDate(statementEnd, true);
  if (through) return `Statement through ${through}`;
  const imported = formatPortfolioDate(snapshot?.importedAt);
  return imported ? `Imported ${imported}` : "Statement date unavailable";
}

export function formatPlaidBalanceDate(syncedAt: string | null, nowMs: number): string {
  const timestamp = syncedAt ? Date.parse(syncedAt) : NaN;
  const age = nowMs - timestamp;
  if (age >= 0 && age < 86_400_000) return `Plaid synced ${formatRelativeTime(timestamp, nowMs)}`;
  const date = formatPortfolioDate(syncedAt);
  return date ? `Plaid synced ${date}` : "Plaid sync date unavailable";
}

export interface PortfolioDisplayFacts {
  cash: number | null;
  invested: number | null;
  change: number | null;
  changePct: number | null;
}

export function overviewFacts(model: DashboardViewModel, portfolio?: PortfolioData | null): PortfolioDisplayFacts {
  const positions = model.canonicalModel.positions;
  const summary = portfolio?.account_summary;
  const cash = positions.some(position => position.isCashEquivalent)
    ? model.canonicalModel.totals.cashValue
    : finiteAmount(summary?.cash_balance) ?? finiteAmount(portfolio?.cash_balance);
  const invested = positions.length ? positions.filter(position => !position.isCashEquivalent).reduce((total, position) => total + position.marketValue, 0) : null;
  const beginning = finiteAmount(summary?.beginning_value);
  const change = finiteAmount(summary?.change_in_value) ?? (beginning === null ? null : model.hero.totalValue - beginning);
  return { cash, invested, change, changePct: beginning !== null && beginning > 0 && change !== null ? change / beginning * 100 : null };
}

function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
