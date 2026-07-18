import { describe, expect, it } from "vitest";

import { buildKaiAnalysisPreviewRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for buildKaiAnalysisPreviewRoute.
 *
 * Implementation boundary (routes.ts):
 *
 *   export function buildKaiAnalysisPreviewRoute(entries?: {
 *     ticker?: string | null;
 *     pickSource?: string | null;
 *   }) {
 *     return withQuery(ROUTES.KAI_ANALYSIS, {
 *       ticker: entries?.ticker,
 *       pick_source: entries?.pickSource,   // ← key remapping
 *     });
 *   }
 *
 *   ROUTES.KAI_ANALYSIS = "/one/kai/analysis"
 *
 * Truth-first:
 *   - Base path is always "/one/kai/analysis".
 *   - The caller supplies `pickSource` but withQuery receives the key `pick_source`.
 *     This hard-coded remapping is the entire contract this file pins.
 *   - withQuery uses String(value ?? "").trim() and excludes falsy/whitespace values,
 *     so null / undefined / whitespace entries produce no query parameter.
 *   - No case transformation occurs — ticker and pickSource values are passed as-is.
 *   - URLSearchParams insertion order matches Object.entries order: ticker before pick_source.
 */
describe("buildKaiAnalysisPreviewRoute", () => {
  describe("base path — no query string", () => {
    it("returns the bare KAI_ANALYSIS path when called with no arguments", () => {
      expect(buildKaiAnalysisPreviewRoute()).toBe("/one/kai/analysis");
    });

    it("returns the bare path when both entries are null", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: null, pickSource: null })).toBe(
        "/one/kai/analysis"
      );
    });

    it("returns the bare path when both entries are whitespace — trimmed to empty by withQuery", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: "  ", pickSource: "  " })).toBe(
        "/one/kai/analysis"
      );
    });

    it("returns the bare path when called with an empty entries object", () => {
      expect(buildKaiAnalysisPreviewRoute({})).toBe("/one/kai/analysis");
    });
  });

  describe("ticker query key passthrough", () => {
    it("appends ticker under the ticker key", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: "AAPL" })).toBe(
        "/one/kai/analysis?ticker=AAPL"
      );
    });

    it("does not transform the ticker value — lowercase is preserved as-is", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: "aapl" })).toBe(
        "/one/kai/analysis?ticker=aapl"
      );
    });

    it("excludes ticker when it is null", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: null })).toBe("/one/kai/analysis");
    });
  });

  describe("pickSource → pick_source key remapping", () => {
    it("maps the pickSource argument to the pick_source query key", () => {
      expect(buildKaiAnalysisPreviewRoute({ pickSource: "ria" })).toBe(
        "/one/kai/analysis?pick_source=ria"
      );
    });

    it("excludes pick_source when pickSource is null", () => {
      expect(buildKaiAnalysisPreviewRoute({ pickSource: null })).toBe("/one/kai/analysis");
    });
  });

  describe("combined ticker and pick_source", () => {
    it("includes both query keys when both values are provided", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: "NVDA", pickSource: "ria" })).toBe(
        "/one/kai/analysis?ticker=NVDA&pick_source=ria"
      );
    });

    it("omits a key whose value is null while keeping the other", () => {
      expect(buildKaiAnalysisPreviewRoute({ ticker: "TSLA", pickSource: null })).toBe(
        "/one/kai/analysis?ticker=TSLA"
      );
    });
  });
});