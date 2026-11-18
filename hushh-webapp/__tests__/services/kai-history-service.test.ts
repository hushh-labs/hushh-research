import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
  compactAnalysisHistoryEntryForStorage,
  findAnalysisHistoryEntryByRouteId,
  getAnalysisHistoryEntryRouteId,
  KaiHistoryService,
  type AnalysisHistoryEntry,
} from "@/lib/services/kai-history-service";

const pkm = vi.hoisted(() => ({ load: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: pkm.load },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: pkm.write },
}));

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

it("reads legacy PKM history and keeps only the latest new result on this device without writing to PKM", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  // Web Crypto in Node expects buffer sources from its own realm.
  const bytes = new TextEncoder().encode("");
  vi.stubGlobal("Uint8Array", bytes.constructor);
  vi.stubGlobal("ArrayBuffer", bytes.buffer.constructor);
  try {
    const owner = { userId: "finance-history-owner", vaultKey: "ab".repeat(32) };
    const legacy = entry({ ticker: "MSFT", raw_card: { debate_run_id: "legacy" } });
    pkm.load.mockResolvedValue({ analysis_history: { MSFT: [legacy] } });
    const earlier = entry({ raw_card: { debate_run_id: "earlier" } });
    const latest = entry({ timestamp: "2026-08-11T12:00:00.000Z", raw_card: { debate_run_id: "latest" } });
    const save = (result: AnalysisHistoryEntry) => KaiHistoryService.saveAnalysis({ ...owner, entry: result, isCurrent: () => true });

    await expect(save(earlier)).resolves.toBe(true);
    await expect(save(latest)).resolves.toBe(true);
    await expect(save(earlier)).resolves.toBe(true);
    await expect(KaiHistoryService.getAllHistory(owner)).resolves.toEqual({ MSFT: [legacy], NVDA: [latest] });
    await expect(KaiHistoryService.getAllHistory({ ...owner, vaultKey: "bc".repeat(32) })).resolves.toEqual({ MSFT: [legacy] });
    await expect(KaiHistoryService.deleteEntry({ ...owner, ticker: "NVDA", timestamp: latest.timestamp, streamId: "latest" })).resolves.toBe(true);
    await expect(KaiHistoryService.getAllHistory(owner)).resolves.toEqual({ MSFT: [legacy] });
    expect(pkm.write).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
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
