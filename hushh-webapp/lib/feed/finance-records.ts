import { advisorWorkspaceHref, type AdvisorReview } from "@/lib/advisor-review/contract";
import { getStatementSnapshotOptions } from "@/lib/kai/brokerage/financial-sources";
import { savedAnalysisFeedHref, feedStatementHref } from "@/lib/feed/source-routes";
import {
  getAnalysisHistoryEntryRouteId,
  type AnalysisHistoryMap,
} from "@/lib/services/kai-history-service";

export type FinanceFeedRecord = {
  kind: "statement" | "analysis" | "advisor" | "institution" | "transfer";
  symbol?: string;
  person?: string;
  operationKey?: string;
  href: string;
  title: string;
  timestamp: string | null;
  searchable: readonly (string | null | undefined)[];
};

export function financeFeedRecords(
  financial: Record<string, unknown> | null,
  history: AnalysisHistoryMap,
  reviews: AdvisorReview[],
  institutions: FinanceFeedRecord[] = [],
): FinanceFeedRecord[] {
  return [
    ...institutions,
    ...getStatementSnapshotOptions(financial).map(statement => ({
      kind: "statement" as const,
      href: feedStatementHref(statement.id),
      title: `${statement.label} · Saved statement`,
      timestamp: statement.importedAt || statement.statementPeriodEnd || null,
      searchable: [statement.label, statement.id, statement.brokerage, statement.statementPeriodEnd, "saved statement"],
    })),
    ...Object.values(history).flat().map(entry => {
      const id = getAnalysisHistoryEntryRouteId(entry);
      return {
        kind: "analysis" as const,
        symbol: entry.ticker,
        operationKey: id.startsWith("run:") ? `finance-analysis:${id.slice(4)}` : undefined,
        href: savedAnalysisFeedHref(id),
        title: `${entry.ticker} · Saved analysis`,
        timestamp: entry.timestamp,
        searchable: [entry.ticker, id, "saved analysis report"],
      };
    }),
    ...reviews.map(review => {
      const received = review.direction === "received";
      const name = received ? review.ownerName : review.advisorName;
      return {
        kind: "advisor" as const,
        person: name,
        operationKey: `advisor-review:${review.id.toLowerCase()}`,
        href: advisorWorkspaceHref(review.id, received),
        title: `${name} · Advisor request ${review.status}`,
        timestamp: review.createdAt,
        searchable: [name, review.id, review.status, "advisor portfolio review"],
      };
    }),
  ].sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0));
}

export function searchFinanceFeedRecords(records: FinanceFeedRecord[], query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return records.filter(record => {
    const timestamp = record.timestamp ? new Date(record.timestamp) : null;
    const displayDate = timestamp && Number.isFinite(timestamp.getTime())
      ? timestamp.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", ...(record.timestamp?.length === 10 ? { timeZone: "UTC" } : {}) })
      : "";
    const haystack = [...record.searchable, record.timestamp, displayDate].join(" ").toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
