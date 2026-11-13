import { describe, it, expect } from "vitest";
import { applyExtractionProgress, extractionPreviewRows } from "@/lib/kai/import/extraction-progress";
import type { KaiStreamEnvelope, PortfolioImportExtractionUpdate } from "@/lib/streaming/kai-stream-types";

const event = (seq: number, page = 1): KaiStreamEnvelope => ({
  schema_version: "1.0", stream_kind: "portfolio_import", stream_id: "synthetic-run", seq,
  event: "progress", terminal: false,  payload: {
    extraction_update: { version: 1, revision: 1, unit_id: `pdf:${page}`, unit_index: page, units_total: 2, source_kind: "pdf",
      rows: [{ source_id: `pdf:${page}:1`, symbol: "SAME", market_value: 0 }], facts: { cash_balance: 0 } },
  },
});

describe("memory-only import extraction progress", () => {
  it("keeps identical lots distinct and applies duplicate replay only once", () => {
    const first = applyExtractionProgress(null, event(1), "owner")!;
    expect(applyExtractionProgress(first, event(2), "owner")).toBe(first);
    const second = applyExtractionProgress(first, event(3, 2), "owner")!;
    expect(extractionPreviewRows(second).map(row => row.source_id)).toEqual(["pdf:1:1", "pdf:2:1"]);
    expect(second.foundCount).toBe(2);
    expect(second.facts.cash_balance).toBe(0);
  });
  it("fences old units after fallback and rejects cross-owner or cross-stream facts", () => {
    const first = applyExtractionProgress(null, event(1), "owner")!;
    const reset = applyExtractionProgress(first, { ...event(5), payload: { extraction_reset: true } }, "owner")!;
    expect(extractionPreviewRows(reset)).toEqual([]);
    expect(reset.facts).toEqual({});
    expect(applyExtractionProgress(reset, event(4, 2), "owner")).toBe(reset);
    expect(applyExtractionProgress(reset, event(6, 2), "other-owner")).toBe(reset);
    expect(applyExtractionProgress(reset, { ...event(6, 2), stream_id: "other-run" }, "owner")).toBe(reset);
  });
  it("bounds provisional rows without dropping the final found count", () => {
    const frame = event(1);
    (frame.payload.extraction_update as PortfolioImportExtractionUpdate).rows = Array.from({ length: 1500 }, (_, i) => ({ source_id: `pdf:1:${i + 1}`, symbol: "SAME" }));
    const state = applyExtractionProgress(null, frame, "owner")!;
    expect(state.foundCount).toBe(1500);
    expect(extractionPreviewRows(state)).toHaveLength(1000);
  });
});
