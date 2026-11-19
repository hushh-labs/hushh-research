import { describe, expect, it } from "vitest";
import { financeFeedRecords, searchFinanceFeedRecords } from "@/lib/feed/finance-records";
import { historicalFundingTerms } from "@/lib/feed/historical-funding";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";
import { findAnalysisHistoryEntryByRouteId, type AnalysisHistoryEntry } from "@/lib/services/kai-history-service";

function feedItem(
  eventType: string,
  metadata: Record<string, unknown>,
  sourceDomain: FeedItem["source_domain"] = "location",
): FeedItem {
  return {
    id: `feed:${eventType}`,
    source_domain: sourceDomain,
    event_type: eventType,
    actor_label: null,
    metadata,
    read: false,
    created_at: "2026-08-26T00:00:00.000Z",
  };
}

describe("Kai analysis ready Feed item", () => {
  const savedEntry: AnalysisHistoryEntry = {
    ticker: "NVDA",
    timestamp: "2026-09-27T10:00:00.000Z",
    decision: "hold",
    confidence: 0.6,
    consensus_reached: true,
    agent_votes: {},
    final_statement: "",
    raw_card: { debate_run_id: "run_abc" },
  };

  function openedAnalysisId(metadata: Record<string, unknown>): string | null {
    const href = presentFeedItem(feedItem("kai_analysis_saved", metadata, "kai")).href;
    const query = new URLSearchParams(href?.split("?")[1] ?? "");
    // The stock preview (and its start sheet) opens only from `ticker`.
    expect(query.has("ticker")).toBe(false);
    return query.get("analysis_id");
  }

  it("opens the run's own saved result", () => {
    expect(presentFeedItem(feedItem("kai_analysis_saved", { ticker: "NVDA", run_id: "run_abc" }, "kai")).symbol).toBe("NVDA");
    const analysisId = openedAnalysisId({ ticker: "NVDA", run_id: "run_abc" });
    expect(analysisId).not.toBeNull();
    expect(
      findAnalysisHistoryEntryByRouteId({ NVDA: [
        { ...savedEntry, raw_card: { debate_run_id: "another_run" } },
        savedEntry,
      ] }, analysisId!),
    ).toBe(savedEntry);
    // A result that is gone resolves to nothing, which the analysis page shows
    // as "This analysis is no longer available" rather than a start sheet.
    expect(findAnalysisHistoryEntryByRouteId({}, analysisId!)).toBeNull();
  });

  it("does not link an item without a saved run id", () => {
    expect(openedAnalysisId({ ticker: "NVDA" })).toBeNull();
  });
});

it("finds an older statement without substituting the active statement", () => {
  const records = financeFeedRecords({
    documents: { statements: [
      { id: "stmt_nov", source: { brokerage: "Example Brokerage", statement_period_end: "2026-11-01" } },
      { id: "stmt_oct", source: { brokerage: "Example Brokerage", statement_period_end: "2025-10-01" } },
    ] },
  }, {}, []);
  const results = searchFinanceFeedRecords(records, "October 2025");
  expect(results).toHaveLength(1);
  const target = new URL(results[0]!.href, "https://test.invalid");
  expect(target.pathname).toBe("/one/kai/import");
  expect(target.searchParams.get("statement_id")).toBe("stmt_oct");
  expect(target.searchParams.get("from")).toBe("/one/feed");
});

it("keeps names and ticker terms out of the historical transfer request", () => {
  expect(historicalFundingTerms("returned October 2025")).toBe("returned october 2025");
  expect(historicalFundingTerms("Example Brokerage October")).toBe("");
  expect(historicalFundingTerms("AAPL failed")).toBe("");
});
