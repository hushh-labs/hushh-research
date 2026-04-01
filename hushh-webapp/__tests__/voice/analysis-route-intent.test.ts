import { describe, expect, it } from "vitest";

import { deriveAnalysisRouteIntent } from "@/lib/kai/analysis-route-intent";

function params(raw: string): URLSearchParams {
  const normalized = raw.startsWith("?") ? raw.slice(1) : raw;
  return new URLSearchParams(normalized);
}

describe("deriveAnalysisRouteIntent", () => {
  it("ignores empty query state", () => {
    expect(deriveAnalysisRouteIntent(params(""))).toEqual({
      shouldApply: false,
      focusActive: false,
      runId: null,
      showHistory: false,
      workspaceTab: null,
    });
  });

  it("opens history rail when tab=history", () => {
    expect(deriveAnalysisRouteIntent(params("tab=history"))).toEqual({
      shouldApply: true,
      focusActive: false,
      runId: null,
      showHistory: true,
      workspaceTab: null,
    });
  });

  it("routes workspace tab when tab=summary", () => {
    expect(deriveAnalysisRouteIntent(params("tab=summary"))).toEqual({
      shouldApply: true,
      focusActive: false,
      runId: null,
      showHistory: false,
      workspaceTab: "summary",
    });
  });

  it("prioritizes active focus/run intent over tab intent", () => {
    expect(deriveAnalysisRouteIntent(params("tab=history&focus=active&run_id=run_1"))).toEqual({
      shouldApply: true,
      focusActive: true,
      runId: "run_1",
      showHistory: false,
      workspaceTab: null,
    });
  });
});
