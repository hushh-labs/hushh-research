import { describe, it, expect } from "vitest";
import { buildKaiAnalysisPreviewRoute, ROUTES } from "@/lib/navigation/routes";

describe("buildKaiAnalysisPreviewRoute — query construction contract", () => {
  it("returns the bare analysis path when called with no arguments", () => {
    expect(buildKaiAnalysisPreviewRoute()).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("returns the bare analysis path when entries is an empty object", () => {
    expect(buildKaiAnalysisPreviewRoute({})).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("maps ticker to the ticker query parameter", () => {
    expect(buildKaiAnalysisPreviewRoute({ ticker: "AAPL" })).toBe(
      "/one/kai/analysis?ticker=AAPL"
    );
  });

  it("maps pickSource to the pick_source query parameter (key transform)", () => {
    expect(buildKaiAnalysisPreviewRoute({ pickSource: "ria_pick" })).toBe(
      "/one/kai/analysis?pick_source=ria_pick"
    );
  });

  it("includes both parameters in ticker-then-pick_source order", () => {
    expect(
      buildKaiAnalysisPreviewRoute({ ticker: "AAPL", pickSource: "ria_pick" })
    ).toBe("/one/kai/analysis?ticker=AAPL&pick_source=ria_pick");
  });

  it("omits ticker when it is null", () => {
    expect(
      buildKaiAnalysisPreviewRoute({ ticker: null, pickSource: "ria_pick" })
    ).toBe("/one/kai/analysis?pick_source=ria_pick");
  });

  it("omits pickSource when it is undefined", () => {
    expect(
      buildKaiAnalysisPreviewRoute({ ticker: "AAPL", pickSource: undefined })
    ).toBe("/one/kai/analysis?ticker=AAPL");
  });

  it("omits ticker when it is a whitespace-only string", () => {
    expect(
      buildKaiAnalysisPreviewRoute({ ticker: "   ", pickSource: "ria_pick" })
    ).toBe("/one/kai/analysis?pick_source=ria_pick");
  });

  it("trims surrounding whitespace from a provided ticker value", () => {
    expect(buildKaiAnalysisPreviewRoute({ ticker: "  AAPL  " })).toBe(
      "/one/kai/analysis?ticker=AAPL"
    );
  });
});