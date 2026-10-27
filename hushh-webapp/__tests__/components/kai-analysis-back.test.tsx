import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Children, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KaiAnalysisPageContent } from "@/app/one/kai/analysis/page";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";

// Keep the real Finance page, query subscription and shared Back resolver.
// Child views and provider/owner ports use synthetic observations only.
const state = vi.hoisted(() => {
  let href = "/one/kai?tab=analysis";
  const listeners = new Set<() => void>();
  const navigate = (next: string) => { href = next; listeners.forEach(fn => fn()); };
  return {
    navigate, getHref: () => href,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    router: { push: navigate, replace: navigate },
    tasks: [] as { runId: string; ticker: string; userId: string; status: string; startedAt: string }[],
    taskListeners: new Set<(value: { tasks: unknown[] }) => void>(),
    cancel: vi.fn(), setAnalysisParams: vi.fn(), setBusy: vi.fn(), context: vi.fn(), actions: new Map<string, () => unknown>(),
    analysisParams: null as Record<string, unknown> | null, analysisParamsUpdatedAt: 0,
    entry: { ticker: "TEST", timestamp: "2026-10-20T14:00:00Z", final_statement: "Saved result", raw_card: { debate_run_id: "run-1" } },
  };
});
vi.mock("next/navigation", async () => {
  const React = await import("react");
  const useHref = () => React.useSyncExternalStore(state.subscribe, state.getHref);
  return {
    useRouter: () => state.router,
    usePathname: () => new URL(useHref(), "https://app.test").pathname,
    useSearchParams: () => {
      const href = useHref();
      return React.useMemo(() => new URL(href, "https://app.test").searchParams, [href]);
    },
  };
});
vi.mock("@/components/icons", () => ({ ArrowLeft: () => null, X: () => null, MessageCircle: () => null, Laptop: () => null, LayoutDashboard: () => null }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { dismiss: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" }, userId: "synthetic-owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" }) }));
vi.mock("@/lib/stores/kai-session-store", () => ({ useKaiSession: (select: (s: unknown) => unknown) => select({ analysisParams: state.analysisParams, analysisParamsUpdatedAt: state.analysisParamsUpdatedAt, setAnalysisParams: state.setAnalysisParams, setBusyOperation: state.setBusy }) }));
vi.mock("@/lib/services/debate-run-manager", () => ({ DebateRunManagerService: {
  subscribe: (fn: (s: { tasks: unknown[] }) => void) => { state.taskListeners.add(fn); fn({ tasks: state.tasks }); return () => { state.taskListeners.delete(fn); }; },
  resumeActiveRun: vi.fn().mockResolvedValue(null), cancelRun: state.cancel,
} }));
vi.mock("@/lib/services/kai-history-service", () => ({
  KaiHistoryService: { getAllHistory: vi.fn(async () => ({ TEST: [state.entry] })) },
  findAnalysisHistoryEntryByRouteId: () => state.entry,
  getAnalysisHistoryEntryRouteId: () => "run:run-1",
}));
vi.mock("@/lib/kai/market-snapshot", () => ({
  getLatestMarketSnapshotFromCache: () => null, marketSnapshotForTicker: () => null,
  pickPreferredMarketSnapshot: () => null, fetchLatestMarketSnapshot: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/services/cache-service", () => ({ CacheService: { getInstance: () => ({ subscribe: () => () => undefined }) } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getKaiStockPreview: vi.fn().mockResolvedValue({ symbol: "TEST" }) } }));
vi.mock("@/lib/services/kai-service", () => ({ getStockContext: state.context }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn(), useVoiceSurfaceControlTracking: () => ({}) }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: (id: string, handler: () => unknown) => { state.actions.set(id, handler); } }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/observability/growth", () => ({ trackInvestorActivationCompleted: vi.fn() }));
vi.mock("@/components/kai/shared/kai-market-home-context", () => ({ useKaiMarketHome: () => ({ activePickSource: "default" }) }));
vi.mock("@/components/app-ui/app-page-shell", () => ({ APP_MEASURE_STYLES: {}, AppPageContentRegion: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/kai/kai-workspace-header", () => ({ KaiWorkspaceHeader: ({ title, actions }: { title: ReactNode; actions: ReactNode }) => <header>{title}{actions}</header> }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => null }));
vi.mock("@/components/app-ui/hushh-loader", () => ({ HushhLoader: () => <p>Loading</p> }));
vi.mock("@/components/app-ui/surfaces", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { SurfaceCard: Box, SurfaceCardContent: Box, SurfaceStack: Box };
});
vi.mock("@/lib/morphy-ux/ui", () => ({ Icon: () => null, SegmentedTabs: () => null }));
vi.mock("@/lib/morphy-ux/ui/swipe-views", () => ({ SwipeViews: ({ activeValue, children }: { activeValue: string; children: ReactNode }) => Children.toArray(children)[["debate", "summary", "detailed"].indexOf(activeValue)] }));
vi.mock("@/components/kai/shared/symbol-avatar", () => ({ SymbolAvatar: () => null }));
vi.mock("@/components/kai/views/round-tabs-card", () => ({ RoundTabsCard: () => null }));
vi.mock("@/components/kai/views/kai-analysis-preview-view", () => ({ KaiAnalysisPreviewView: () => null }));
vi.mock("@/components/kai/views/history-detail-view", () => ({ HistoryDetailView: () => <p>Saved detail</p> }));
vi.mock("@/components/kai/views/analysis-summary-view", () => ({ AnalysisSummaryView: () => <p>Saved summary</p> }));
vi.mock("@/components/kai/views/analysis-history-dashboard", () => ({ AnalysisHistoryDashboard: () => <p>History entries</p> }));
vi.mock("@/components/kai/views/kai-stocks-view", () => ({ KaiStocksView: ({ browseStocks, historyRequested }: { browseStocks: boolean; historyRequested: boolean }) => <>{browseStocks ? <p>Stock browser</p> : null}{historyRequested ? <p>Stock history</p> : null}</> }));
vi.mock("@/components/kai/cards/stock-comparison-preview", () => ({ StockComparisonPreview: () => <p>Preview details</p> }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({ KaiControlSurface: ({ open, children, footer, onOpenChange }: { open: boolean; children: ReactNode; footer: ReactNode; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog" data-state="open" onKeyDown={event => { if (event.key === "Escape") onOpenChange(false); }}>{children}{footer}</div> : null }));
vi.mock("@/components/kai/debate-stream-view", () => ({ DebateStreamView: ({ onDecisionReady }: { onDecisionReady: (entry: unknown, meta: unknown) => void }) => <button onClick={() => onDecisionReady(state.entry, { runId: "run-1" })}>Finish synthetic analysis</button> }));

function back() {
  act(() => {
    const url = new URL(state.getHref(), "https://app.test");
    navigateTopShellBack({ pathname: url.pathname, searchParams: url.searchParams, sectionOrigin: null, navigate: action => state.navigate(action.href) });
  });
}

beforeEach(() => {
  state.tasks = [];
  state.taskListeners.clear();
  state.cancel.mockClear();
  state.setAnalysisParams.mockClear();
  state.analysisParams = null;
  state.analysisParamsUpdatedAt = 0;
  state.setAnalysisParams.mockImplementation(value => {
    state.analysisParams = value;
    state.analysisParamsUpdatedAt = value ? Date.now() : 0;
  });
  state.context.mockReset();
  state.actions.clear();
  state.navigate("/one/kai?tab=analysis");
});

describe("Finance shared Back with the mounted analysis page", () => {
  it("still commits a confirmed preview launch while its screen remains selected", async () => {
    state.context.mockResolvedValue({ user_risk_profile: "balanced" });
    state.navigate("/one/kai?tab=analysis&ticker=TEST");
    render(<KaiAnalysisPageContent />);
    const start = await screen.findByRole("button", { name: "Start analysis debate" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(state.setAnalysisParams).toHaveBeenCalledWith(expect.objectContaining({ ticker: "TEST", launchConfirmed: true })));
    expect(new URL(state.getHref(), "https://app.test").searchParams.get("focus")).toBe("active");
  });

  it.each(["back", "tab"])("ignores a pending preview launch after leaving by %s", async (leave) => {
    let finish!: (value: { user_risk_profile: string }) => void;
    state.context.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    state.navigate("/one/kai?tab=analysis&ticker=TEST");
    render(<KaiAnalysisPageContent />);
    const start = await screen.findByRole("button", { name: "Start analysis debate" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(screen.getByRole("button", { name: "Preparing debate..." })).toBeDisabled();
    if (leave === "back") back();
    else act(() => state.navigate("/one/kai?tab=portfolio"));
    const destination = state.getHref();
    await act(async () => { finish({ user_risk_profile: "balanced" }); });
    expect(state.getHref()).toBe(destination);
    expect(state.setAnalysisParams).not.toHaveBeenCalledWith(expect.objectContaining({ launchConfirmed: true }));
    if (leave === "back") expect(screen.getByText("Stock browser")).toBeVisible();
  });

  it("returns from a running analysis to Stocks without cancelling, and explicitly resumes it", async () => {
    state.tasks = [{ runId: "run-1", ticker: "TEST", userId: "synthetic-owner", status: "running", startedAt: "2026-10-20T14:00:00Z" }];
    state.navigate("/one/kai?tab=analysis&focus=active&run_id=run-1");
    render(<KaiAnalysisPageContent />);
    await screen.findByTestId("kai-analysis-active-run");
    back();
    expect(state.getHref()).toBe("/one/kai?tab=analysis");
    expect(screen.queryByTestId("kai-analysis-active-run")).toBeNull();
    expect(screen.getByText("Stock browser")).toBeVisible();
    expect(state.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open active analysis" }));
    await screen.findByTestId("kai-analysis-active-run");
    expect(new URL(state.getHref(), "https://app.test").searchParams.get("run_id")).toBe("run-1");
    back();
    expect(screen.getByText("Stock browser")).toBeVisible();
    back();
    expect(state.getHref()).toBe("/one");
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("releases a newly completed result when Back returns to Stocks", async () => {
    state.tasks = [{ runId: "run-1", ticker: "TEST", userId: "synthetic-owner", status: "running", startedAt: "2026-10-20T14:00:00Z" }];
    state.navigate("/one/kai?tab=analysis&focus=active&run_id=run-1");
    render(<KaiAnalysisPageContent />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish synthetic analysis" }));
    act(() => {
      state.tasks = [];
      state.taskListeners.forEach(fn => fn({ tasks: [] }));
    });
    await screen.findByText("Saved summary");
    back();
    await waitFor(() => expect(screen.getByText("Stock browser")).toBeVisible());
    expect(screen.queryByText("Saved summary")).toBeNull();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("returns from a saved analysis to the browser on the same mounted page", async () => {
    state.navigate("/one/kai?tab=analysis&analysis_id=run%3Arun-1");
    render(<KaiAnalysisPageContent />);
    await screen.findByText("Saved summary");
    back();
    await screen.findByText("Stock browser");
    expect(screen.queryByText("Saved summary")).toBeNull();
  });

  it("keeps requested History open and lets the voice action explicitly reopen a running analysis", async () => {
    state.tasks = [{ runId: "run-1", ticker: "TEST", userId: "synthetic-owner", status: "running", startedAt: "2026-10-20T14:00:00Z" }];
    state.navigate("/one/kai?tab=analysis&focus=active&run_id=run-1");
    render(<KaiAnalysisPageContent />);
    await screen.findByTestId("kai-analysis-active-run");
    act(() => { state.actions.get("analysis.back_to_history")!(); });
    expect(screen.getByText("Stock history")).toBeVisible();
    expect(screen.queryByTestId("kai-analysis-active-run")).toBeNull();
    act(() => { state.actions.get("analysis.resume_active")!(); });
    await screen.findByTestId("kai-analysis-active-run");
    expect(screen.queryByText("Stock history")).toBeNull();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});
