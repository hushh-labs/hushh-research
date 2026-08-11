import { describe, expect, it } from "vitest";

import {
  findAnalysisHistoryEntryByRouteId,
  getAnalysisHistoryEntryRouteId,
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
