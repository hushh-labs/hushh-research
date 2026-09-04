export type AnalysisWorkspaceTabIntent = "debate" | "summary" | "detailed";

export type AnalysisRouteIntent = {
  shouldApply: boolean;
  focusActive: boolean;
  runId: string | null;
  showHistory: boolean;
  workspaceTab: AnalysisWorkspaceTabIntent | null;
};

export function deriveAnalysisRouteIntent(searchParams: URLSearchParams): AnalysisRouteIntent {
  const hasTabParam = searchParams.has("tab");
  const focus = searchParams.get("focus");
  const focusActive = focus === "active";
  const hasRunIdParam = searchParams.has("run_id");
  const runIdRaw = searchParams.get("run_id");
  const runId = runIdRaw && runIdRaw.trim() ? runIdRaw.trim() : null;
  // The workspace sub-view rides on `view` on the canonical
  // `/one/kai?tab=analysis` route (the legacy `?tab=<sub>` form redirects into
  // it). Read `view` here so `?view=debate` deep-links open the debate route,
  // and a bare `?tab=analysis` lands on the summary table.
  const view = String(searchParams.get("view") || "").trim().toLowerCase();
  const hasViewParam = searchParams.has("view");
  const hasBehavioralParam =
    hasTabParam || focusActive || hasRunIdParam || hasViewParam;

  if (!hasBehavioralParam) {
    return {
      shouldApply: false,
      focusActive: false,
      runId: null,
      showHistory: false,
      workspaceTab: null,
    };
  }

  const showHistory =
    !focusActive && !hasRunIdParam && (view === "history" || view === "transcript");
  // `focus`/`run_id` select the RUN; `view` selects the tab. Gating the tab on
  // those two let `focus=active` silently pin the workspace to debate, so any
  // deliberate switch -- by hand or by voice -- was reverted on the next
  // render. An explicit view is the person's own choice and outranks them.
  const workspaceTab: AnalysisWorkspaceTabIntent | null =
    view === "debate" || view === "summary" || view === "detailed" ? view : null;

  return {
    shouldApply: true,
    focusActive,
    runId,
    showHistory,
    workspaceTab,
  };
}
