import { describe, expect, it } from "vitest";

import {
  compactAnalysisHistoryEntryForStorage,
  findAnalysisHistoryEntryByRouteId,
  getAnalysisHistoryEntryRouteId,
  prependAnalysisHistoryEntry,
  type AnalysisHistoryEntry,
} from "@/lib/services/kai-history-service";

function entry(
  overrides: Partial<AnalysisHistoryEntry> = {},
): AnalysisHistoryEntry {
  return {
    ticker: "NVDA",
    timestamp: "2026-08-10T12:00:00.000Z",
    decision: "hold",
    confidence: 0.7,
    consensus_reached: true,
    agent_votes: {},
    final_statement: "Hold.",
    raw_card: {},
    ...overrides,
  };
}

describe("analysis history route identity", () => {
  it("prefers the persisted debate run id over stream diagnostics", () => {
    expect(
      getAnalysisHistoryEntryRouteId(
        entry({
          raw_card: {
            debate_run_id: "debate_123",
            stream_diagnostics: { stream_id: "stream_456" },
          },
        }),
      ),
    ).toBe("run:debate_123");
  });

  it("uses stream diagnostics, then a deterministic legacy identity", () => {
    expect(
      getAnalysisHistoryEntryRouteId(
        entry({
          raw_card: { stream_diagnostics: { stream_id: "stream_456" } },
        }),
      ),
    ).toBe("run:stream_456");
    expect(getAnalysisHistoryEntryRouteId(entry())).toBe(
      "saved:NVDA:2026-08-10T12:00:00.000Z",
    );
  });

  it("finds a saved entry after a query-backed route reload", () => {
    const saved = entry();
    const history = { NVDA: [saved] };

    expect(
      findAnalysisHistoryEntryByRouteId(
        history,
        "saved:NVDA:2026-08-10T12:00:00.000Z",
      ),
    ).toBe(saved);
  });
});

describe("analysis history retention", () => {
  it("retains only the newest three analyses per ticker", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entry({
        timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
        raw_card: { debate_run_id: `run-${index}` },
      }),
    ).reduce<AnalysisHistoryEntry[]>(
      (history, next) => prependAnalysisHistoryEntry(history, next).entries,
      [],
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((item) => item.raw_card.debate_run_id)).toEqual([
      "run-4",
      "run-3",
      "run-2",
    ]);
  });

  it("treats an identical debate run as an idempotent no-op", () => {
    const saved = entry({ raw_card: { debate_run_id: "run-1" } });
    expect(prependAnalysisHistoryEntry([saved], saved)).toEqual({
      entries: [saved],
      changed: false,
    });
  });
});

describe("analysis history storage shape", () => {
  it("keeps replay text without duplicating decision metrics into the transcript", () => {
    const compacted = compactAnalysisHistoryEntryForStorage(
      entry({
        raw_card: { key_metrics: { revenue: 100 }, debate_run_id: "run-1" },
        debate_transcript: {
          round1: {
            fundamental: {
              stage: "complete",
              text: "Revenue is improving.",
              thoughts: [],
              statusMessage: "Analysis complete",
              keyMetrics: { revenue: 100 },
              quantMetrics: { margin: 0.4 },
              sources: ["SEC"],
            },
          },
          round2: {},
        },
      }),
    );

    expect(compacted.raw_card).toEqual({
      key_metrics: { revenue: 100 },
      debate_run_id: "run-1",
    });
    expect(compacted.debate_transcript?.round1.fundamental).toEqual({
      stage: "complete",
      text: "Revenue is improving.",
      thoughts: [],
      statusMessage: "Analysis complete",
    });
  });
});
