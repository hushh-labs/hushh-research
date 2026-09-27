/**
 * Route id of a saved analysis produced by a debate run: the value of
 * `analysis_id` that opens that run's result. Shared by the history store and
 * every link to a run's result (the Feed's "Analysis ready" item).
 */
export function getAnalysisHistoryRunRouteId(runId: string): string {
  return `run:${runId}`;
}

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

export type AnalysisPreviewGate = {
  previewTicker: string;
  hasRunRouteIntent: boolean;
  hasActiveRouteIntent: boolean;
  hasConfirmedAnalysisIntent: boolean;
  showHistoryWhileActive: boolean;
  hasDebateId: boolean;
  hasActiveRun: boolean;
  hasFocusedRun: boolean;
  hasOpenEntry: boolean;
  /**
   * True from the moment a live debate is cancelled until the URL stops naming
   * it. Cancelling clears the confirmed launch intent at once, while the URL
   * still carries `focus=active&ticker=...`; without this gate that gap read as
   * an unconfirmed deep link and reopened the stock preview (with its
   * research-source picker) on top of the page the person was returning to.
   */
  closingLiveDebate: boolean;
};

/** Whether the stock preview sheet (and its research-source picker) opens. */
export function shouldShowAnalysisPreview(gate: AnalysisPreviewGate): boolean {
  if (gate.closingLiveDebate) return false;
  return (
    Boolean(gate.previewTicker) &&
    !gate.hasRunRouteIntent &&
    (!gate.hasActiveRouteIntent || !gate.hasConfirmedAnalysisIntent) &&
    !gate.showHistoryWhileActive &&
    !gate.hasDebateId &&
    !gate.hasActiveRun &&
    !gate.hasFocusedRun &&
    !gate.hasOpenEntry
  );
}

/**
 * The saved analysis a cancelled debate returns to: the newest one for the
 * same ticker, or none (the analysis landing). The caller builds the route
 * from it and never carries `ticker`/`focus`, so the preview cannot reopen.
 */
export function pickCancelledAnalysisReturnEntry<
  T extends { ticker: string; timestamp: string },
>(ticker: string, entries: readonly T[]): T | null {
  const wanted = String(ticker || "").trim().toUpperCase();
  if (!wanted) return null;
  let newest: T | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (String(entry.ticker || "").trim().toUpperCase() !== wanted) continue;
    const at = Date.parse(entry.timestamp);
    const rank = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (!newest || rank > newestAt) {
      newest = entry;
      newestAt = rank;
    }
  }
  return newest;
}
