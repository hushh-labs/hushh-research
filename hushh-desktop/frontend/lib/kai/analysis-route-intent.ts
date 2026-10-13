export type AnalysisWorkspaceTabIntent = "debate" | "summary";

export type AnalysisRouteIntent = {
  shouldApply: boolean;
  focusActive: boolean;
  runId: string | null;
  showHistory: boolean;
  workspaceTab: AnalysisWorkspaceTabIntent | null;
};

export function deriveAnalysisRouteIntent(searchParams: URLSearchParams): AnalysisRouteIntent {
  const hasTabParam = searchParams.has("tab");
  const tab = String(searchParams.get("tab") || "").trim().toLowerCase();
  const focus = searchParams.get("focus");
  const focusActive = focus === "active";
  const hasRunIdParam = searchParams.has("run_id");
  const runIdRaw = searchParams.get("run_id");
  const runId = runIdRaw && runIdRaw.trim() ? runIdRaw.trim() : null;
  const hasBehavioralParam = hasTabParam || focusActive || hasRunIdParam;

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
    !focusActive && !hasRunIdParam && (tab === "history" || tab === "transcript");
  const workspaceTab: AnalysisWorkspaceTabIntent | null =
    !focusActive && !hasRunIdParam && (tab === "debate" || tab === "summary") ? tab : null;

  return {
    shouldApply: true,
    focusActive,
    runId,
    showHistory,
    workspaceTab,
  };
}
