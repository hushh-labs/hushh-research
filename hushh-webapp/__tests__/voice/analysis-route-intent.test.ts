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

  it("opens history rail when view=history", () => {
    expect(deriveAnalysisRouteIntent(params("view=history"))).toEqual({
      shouldApply: true,
      focusActive: false,
      runId: null,
      showHistory: true,
      workspaceTab: null,
    });
  });

  it("routes workspace tab when view=summary", () => {
    expect(deriveAnalysisRouteIntent(params("view=summary"))).toEqual({
      shouldApply: true,
      focusActive: false,
      runId: null,
      showHistory: false,
      workspaceTab: "summary",
    });
  });

  it("opens the debate route when view=debate", () => {
    expect(deriveAnalysisRouteIntent(params("view=debate"))).toEqual({
      shouldApply: true,
      focusActive: false,
      runId: null,
      showHistory: false,
      workspaceTab: "debate",
    });
  });

  it("prioritizes active focus/run intent over view intent", () => {
    expect(deriveAnalysisRouteIntent(params("view=history&focus=active&run_id=run_1"))).toEqual({
      shouldApply: true,
      focusActive: true,
      runId: "run_1",
      showHistory: false,
      workspaceTab: null,
    });
  });

  /**
   * `focus`/`run_id` choose the run; `view` chooses the tab. They used to be
   * gated together, so the focus param the debate journey puts in the URL
   * pinned the workspace to the debate tab -- reverting every deliberate
   * switch, and looping the voice agent, which kept re-issuing "open summary"
   * against a tab that snapped straight back.
   */
  it("keeps an explicit tab when a run is also focused", () => {
    expect(deriveAnalysisRouteIntent(params("view=summary&focus=active&ticker=NVDA"))).toEqual({
      shouldApply: true,
      focusActive: true,
      runId: null,
      showHistory: false,
      workspaceTab: "summary",
    });
  });

  it("still defaults to the debate view when focus names no tab", () => {
    expect(deriveAnalysisRouteIntent(params("focus=active&ticker=NVDA")).workspaceTab).toBeNull();
  });
});
