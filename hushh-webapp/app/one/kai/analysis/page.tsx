"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { ClientRedirect } from "@/components/navigation/client-redirect";
import { Badge } from "@/components/ui/badge";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import {
  APP_MEASURE_STYLES,
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SurfaceCard, SurfaceCardContent, SurfaceStack } from "@/components/app-ui/surfaces";
import { DebateStreamView, type AgentState } from "@/components/kai/debate-stream-view";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { AnalysisHistoryDashboard } from "@/components/kai/views/analysis-history-dashboard";
import { KaiAnalysisPreviewView } from "@/components/kai/views/kai-analysis-preview-view";
import { AnalysisSummaryView } from "@/components/kai/views/analysis-summary-view";
import { HistoryDetailView } from "@/components/kai/views/history-detail-view";
import { StockComparisonPreview } from "@/components/kai/cards/stock-comparison-preview";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon, SegmentedTabs } from "@/lib/morphy-ux/ui";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { useAuth } from "@/lib/firebase/auth-context";
import { KaiHistoryService, type AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import { showDebateAlreadyRunningToast } from "@/lib/kai/debate-run-notifications";
import { trackEvent } from "@/lib/observability/client";
import { trackInvestorActivationCompleted } from "@/lib/observability/growth";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { useVault } from "@/lib/vault/vault-context";
import { RoundTabsCard } from "@/components/kai/views/round-tabs-card";
import {
  DebateRunManagerService,
  type DebateRunTask,
} from "@/lib/services/debate-run-manager";
import {
  fetchLatestMarketSnapshot,
  getLatestMarketSnapshotFromCache,
  pickPreferredMarketSnapshot,
  type TickerMarketSnapshot,
} from "@/lib/kai/market-snapshot";
import { cn } from "@/lib/utils";
import { toInvestorLoading, toInvestorMessage } from "@/lib/copy/investor-language";
import { ApiService, type KaiStockPreviewResponse } from "@/lib/services/api-service";
import {
  getKaiActivePickSource,
  setKaiActivePickSource,
} from "@/lib/kai/pick-source-selection";
import { deriveAnalysisRouteIntent } from "@/lib/kai/analysis-route-intent";
import { getAnalysisSuggestions } from "@/lib/kai/analysis-suggestions";
import { getStockContext } from "@/lib/services/kai-service";
import {
  buildKaiAnalysisPreviewRoute,
  buildKaiMarketRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { isLocalAnalysisPreviewRequest } from "@/components/kai/shared/local-market-preview";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";

const ANALYSIS_INTENT_FRESH_MS = 15_000;
type WorkspaceTab = "debate" | "summary" | "detailed";

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function extractDebateId(entry: AnalysisHistoryEntry | null): string | null {
  if (!entry || typeof entry !== "object") return null;
  const rawCard = (entry.raw_card || {}) as Record<string, unknown>;
  const diagnostics = rawCard.stream_diagnostics as Record<string, unknown> | undefined;
  const streamId = diagnostics?.stream_id;
  if (typeof streamId === "string" && streamId.trim()) {
    return streamId.trim();
  }
  return null;
}

function HistoryDebateReplay({ entry }: { entry: AnalysisHistoryEntry }) {
  const [collapsedRounds, setCollapsedRounds] = useState<Record<number, boolean>>({
    1: true,
    2: false,
  });

  if (!entry.debate_transcript) {
    return (
      <div
        className="mx-auto w-full rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground"
        style={APP_MEASURE_STYLES.reading}
      >
        Debate transcript unavailable for this run.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full space-y-4 pb-safe" style={APP_MEASURE_STYLES.reading}>
      <RoundTabsCard
        roundNumber={1}
        title="Initial Deep Analysis"
        description="Agents analyzed source information independently."
        isCollapsed={collapsedRounds[1] ?? true}
        onToggleCollapse={() => setCollapsedRounds((prev) => ({ ...prev, 1: !prev[1] }))}
        agentStates={entry.debate_transcript.round1 as Record<string, AgentState>}
      />
      {entry.debate_transcript.round2 &&
      Object.keys(entry.debate_transcript.round2).length > 0 ? (
        <RoundTabsCard
          roundNumber={2}
          title="Strategic Debate"
          description="Agents challenged and refined positions."
          isCollapsed={collapsedRounds[2] ?? false}
          onToggleCollapse={() => setCollapsedRounds((prev) => ({ ...prev, 2: !prev[2] }))}
          agentStates={entry.debate_transcript.round2 as Record<string, AgentState>}
        />
      ) : null}
    </div>
  );
}

export function KaiAnalysisPageContent() {
  const pageOpenedAtRef = useRef(Date.now());
  const workspaceTopRef = useRef<HTMLDivElement | null>(null);
  const summaryLoadingToastIdRef = useRef<string | number | null>(null);
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const localAnalysisPreview = isLocalAnalysisPreviewRequest({
    pathname,
    searchParams,
    hostname: typeof window === "undefined" ? null : window.location.hostname,
  });

  const { user, userId } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();

  const analysisParams = useKaiSession((s) => s.analysisParams);
  const analysisParamsUpdatedAt = useKaiSession((s) => s.analysisParamsUpdatedAt);
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const setBusyOperation = useKaiSession((s) => s.setBusyOperation);

  const debateId = searchParams.get("debate_id");

  const [resolvedEntry, setResolvedEntry] = useState<AnalysisHistoryEntry | null>(null);
  const [resolvingEntry, setResolvingEntry] = useState(false);
  const [liveEntry, setLiveEntry] = useState<AnalysisHistoryEntry | null>(null);
  const [historyFallbackEntry, setHistoryFallbackEntry] = useState<AnalysisHistoryEntry | null>(null);
  const [activeRunTask, setActiveRunTask] = useState<DebateRunTask | null>(null);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [focusedRunTask, setFocusedRunTask] = useState<DebateRunTask | null>(null);
  const [showHistoryWhileActive, setShowHistoryWhileActive] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  // Landing shows the summary "table"; debate is its own ?view=debate route.
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("summary");
  const workspaceTabOptions = useMemo(
    () => [
      { value: "debate", label: "Debate" },
      { value: "summary", label: "Summary" },
      { value: "detailed", label: "Detailed View" },
    ],
    [],
  );
  const [headerSnapshot, setHeaderSnapshot] = useState<TickerMarketSnapshot | null>(null);
  const [headerSnapshotLoading, setHeaderSnapshotLoading] = useState(false);
  const [stockPreview, setStockPreview] = useState<KaiStockPreviewResponse | null>(null);
  const [stockPreviewLoading, setStockPreviewLoading] = useState(false);
  const [stockPreviewError, setStockPreviewError] = useState<string | null>(null);
  const [previewPickSource, setPreviewPickSource] = useState("default");
  const [startingPreviewDebate, setStartingPreviewDebate] = useState(false);

  const hasFreshAnalysisIntent =
    Boolean(analysisParams) &&
    Boolean(analysisParamsUpdatedAt) &&
    (analysisParamsUpdatedAt || 0) >= pageOpenedAtRef.current - ANALYSIS_INTENT_FRESH_MS;

  const localIntentReady =
    hasFreshAnalysisIntent &&
    analysisParams?.launchConfirmed === true &&
    Boolean(analysisParams?.userId) &&
    analysisParams?.userId !== "__pending__";
  const canStartNewRun =
    localIntentReady &&
    !activeRunTask &&
    !focusedRunTask &&
    !liveEntry &&
    !resolvedEntry;
  const liveIntentReady = Boolean(activeRunTask) || canStartNewRun;

  const setDebateIdParam = useCallback(
    (nextDebateId?: string | null) => {
      const params = new URLSearchParams();
      if (nextDebateId) {
        params.set("debate_id", nextDebateId);
      }
      router.replace(buildKaiMarketRoute("analysis", Object.fromEntries(params.entries())));
    },
    [router]
  );

  useEffect(() => {
    const routeIntent = deriveAnalysisRouteIntent(new URLSearchParams(searchParams.toString()));
    if (!routeIntent.shouldApply) return;

    if (routeIntent.focusActive || routeIntent.runId) {
      if (routeIntent.runId) {
        setFocusedRunId(routeIntent.runId);
      }
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      requestAnimationFrame(() => {
        workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      });
    } else if (routeIntent.showHistory) {
      setFocusedRunId(null);
      setShowHistoryWhileActive(true);
      setWorkspaceTab("debate");
    } else if (routeIntent.workspaceTab) {
      setFocusedRunId(null);
      setShowHistoryWhileActive(false);
      setWorkspaceTab(routeIntent.workspaceTab);
    }

  }, [router, searchParams]);

  useEffect(() => {
    if (!analysisParams) return;
    if (!userId) return;
    if (!analysisParams.userId || analysisParams.userId === "__pending__") {
      setAnalysisParams({
        ...analysisParams,
        userId,
      });
    }
  }, [analysisParams, setAnalysisParams, userId]);

  useEffect(() => {
    if (!analysisParams || !analysisParamsUpdatedAt) return;
    const isFresh = analysisParamsUpdatedAt >= pageOpenedAtRef.current - ANALYSIS_INTENT_FRESH_MS;
    if (!isFresh) {
      setAnalysisParams(null);
    }
  }, [analysisParams, analysisParamsUpdatedAt, setAnalysisParams]);

  useEffect(() => {
    if (!userId) {
      setActiveRunTask(null);
      setFocusedRunTask(null);
      return;
    }

    const unsubscribe = DebateRunManagerService.subscribe((state) => {
      const active = state.tasks
        .filter(
          (task) =>
            task.userId === userId &&
            task.status === "running" &&
            !task.dismissedAt
        )
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      setActiveRunTask(active || null);
      if (focusedRunId) {
        const focused = state.tasks.find(
          (task) =>
            task.runId === focusedRunId &&
            task.userId === userId &&
            !task.dismissedAt
        );
        setFocusedRunTask(focused || null);
      } else {
        setFocusedRunTask(null);
      }
    });

    return unsubscribe;
  }, [focusedRunId, userId]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken || !vaultKey) return;
    void DebateRunManagerService.resumeActiveRun({
      userId,
      vaultOwnerToken,
      vaultKey,
    }).catch(() => undefined);
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    setBusyOperation("stock_analysis_active", Boolean(liveIntentReady));
    return () => {
      setBusyOperation("stock_analysis_active", false);
    };
  }, [liveIntentReady, setBusyOperation]);

  useEffect(() => {
    if (!liveEntry && !resolvedEntry && liveIntentReady) {
      setWorkspaceTab("debate");
    }
  }, [liveEntry, liveIntentReady, resolvedEntry]);

  useEffect(() => {
    if (!debateId || !userId || !vaultKey) {
      setResolvedEntry(null);
      setResolvingEntry(false);
      return;
    }
    const resolvedUserId = userId;
    const resolvedVaultKey = vaultKey;

    let cancelled = false;
    setResolvingEntry(true);

    async function resolveEntry() {
      try {
        const allHistory = await KaiHistoryService.getAllHistory({
          userId: resolvedUserId,
          vaultKey: resolvedVaultKey,
          vaultOwnerToken: vaultOwnerToken || "",
        });
        if (cancelled) return;

        const match = Object.values(allHistory)
          .flat()
          .find((entry) => extractDebateId(entry) === debateId);
        setResolvedEntry(match || null);
      } finally {
        if (!cancelled) {
          setResolvingEntry(false);
        }
      }
    }

    void resolveEntry();

    return () => {
      cancelled = true;
    };
  }, [debateId, userId, vaultKey, vaultOwnerToken]);

  const handleSelectTicker = useCallback(
    (ticker: string) => {
      const normalizedTicker = String(ticker || "").trim().toUpperCase();
      if (!normalizedTicker) return;
      setResolvedEntry(null);
      setLiveEntry(null);
      setFocusedRunId(null);
      setFocusedRunTask(null);
      setAnalysisParams(null);
      setHistoryFallbackEntry(null);
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      setDebateIdParam(null);
      router.push(
        buildKaiAnalysisPreviewRoute({
          ticker: normalizedTicker,
          pickSource: previewPickSource,
        })
      );
    },
    [previewPickSource, router, setAnalysisParams, setDebateIdParam]
  );

  const handleViewHistory = useCallback(
    (entry: AnalysisHistoryEntry) => {
      setAnalysisParams(null);
      setLiveEntry(null);
      setResolvedEntry(entry);
      setFocusedRunId(null);
      setFocusedRunTask(null);
      setShowHistoryWhileActive(false);
      setWorkspaceTab("summary");
      setDebateIdParam(extractDebateId(entry));
    },
    [setAnalysisParams, setDebateIdParam]
  );

  const handleCloseLiveDebate = useCallback(() => {
    if (activeRunTask && vaultOwnerToken) {
      void DebateRunManagerService.cancelRun({
        runId: activeRunTask.runId,
        userId: activeRunTask.userId,
        vaultOwnerToken,
      }).catch(() => undefined);
    }
    setAnalysisParams(null);
    setLiveEntry(null);
    setFocusedRunId(null);
    setFocusedRunTask(null);
    setShowHistoryWhileActive(false);
    setDebateIdParam(null);
  }, [activeRunTask, setAnalysisParams, setDebateIdParam, vaultOwnerToken]);

  const handleReanalyze = useCallback(
    (ticker: string) => {
      const normalizedTicker = String(ticker || "").trim().toUpperCase();
      if (!normalizedTicker) return;
      setResolvedEntry(null);
      setLiveEntry(null);
      setFocusedRunId(null);
      setFocusedRunTask(null);
      setAnalysisParams(null);
      setHistoryFallbackEntry(null);
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      setDebateIdParam(null);
      router.push(
        buildKaiAnalysisPreviewRoute({
          ticker: normalizedTicker,
          pickSource: previewPickSource,
        })
      );
    },
    [previewPickSource, router, setAnalysisParams, setDebateIdParam]
  );

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const setWorkspaceView = useCallback(
    (value: WorkspaceTab) => {
      setWorkspaceTab(value);
      const params = new URLSearchParams(searchParamsRef.current.toString());
      const onDebateRoute = params.get("view") === "debate";
      if (value === "debate") {
        // Debate is its own back-navigable route under Analysis.
        params.set("view", "debate");
        router.push(
          buildKaiMarketRoute("analysis", Object.fromEntries(params.entries())),
          { scroll: false },
        );
      } else if (onDebateRoute) {
        // Leaving the debate route returns to the summary/detailed table.
        params.delete("view");
        router.replace(
          buildKaiMarketRoute("analysis", Object.fromEntries(params.entries())),
          { scroll: false },
        );
      }
      // summary <-> detailed within the table view stays local-only state.
    },
    [router],
  );
  const handleWorkspaceTabChange = useCallback(
    (value: string) => {
      setWorkspaceView(value as WorkspaceTab);
    },
    [setWorkspaceView],
  );

  const handleLiveDecisionReady = useCallback(
    (entry: AnalysisHistoryEntry, meta: { runId: string | null }) => {
      trackEvent(
        "recommendation_viewed",
        {
          result: "success",
          ...(analysisParams?.portfolioSource
            ? { portfolio_source: analysisParams.portfolioSource }
            : {}),
        },
        {
          dedupeKey: `feature:recommendation_viewed:${meta.runId || entry.ticker.toUpperCase()}`,
          dedupeWindowMs: 10_000,
        }
      );
      trackInvestorActivationCompleted({
        portfolioSource: analysisParams?.portfolioSource,
        dedupeKey: `growth:investor:activation:${meta.runId || entry.ticker.toUpperCase()}`,
        dedupeWindowMs: 10_000,
      });
      if (summaryLoadingToastIdRef.current === null) {
        summaryLoadingToastIdRef.current = toast.info("Saving to history…", {
          duration: Infinity,
          description: "Final recommendation is ready. Kai is storing this analysis in your PKM.",
        });
      }
      setLiveEntry(entry);
      setHistoryFallbackEntry(entry);
      setAnalysisParams(null);
      setFocusedRunId(meta.runId);
      setShowHistoryWhileActive(false);
      setWorkspaceTab((prev) => (prev === "debate" ? "summary" : prev));
      requestAnimationFrame(() => {
        workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      });
    },
    [analysisParams?.portfolioSource, setAnalysisParams]
  );

  const handleLiveDecisionPersisted = useCallback((entry: AnalysisHistoryEntry) => {
    setLiveEntry(entry);
    setResolvedEntry(entry);
    setHistoryFallbackEntry(entry);
    setShowHistoryWhileActive(false);
    setWorkspaceTab((prev) => (prev === "debate" ? "summary" : prev));
    setDebateIdParam(extractDebateId(entry));
    if (summaryLoadingToastIdRef.current !== null) {
      toast.dismiss(summaryLoadingToastIdRef.current);
      summaryLoadingToastIdRef.current = null;
    }
    toast.success("Analysis saved to history.");
  }, [setDebateIdParam]);

  const hasFocusedRun = Boolean(focusedRunTask && !focusedRunTask.dismissedAt);
  const activeEntry = liveEntry || resolvedEntry;
  const previewTickerRaw = useMemo(
    () => String(searchParams.get("ticker") || "").trim().toUpperCase(),
    [searchParams]
  );
  const hasActiveRouteIntent = searchParams.get("focus") === "active";
  const hasRunRouteIntent = searchParams.has("run_id");
  const previewPickSourceFromQuery = useMemo(
    () => String(searchParams.get("pick_source") || "").trim(),
    [searchParams]
  );
  const hasConfirmedAnalysisIntent = analysisParams?.launchConfirmed === true;
  const shouldShowPreview =
    Boolean(previewTickerRaw) &&
    !hasRunRouteIntent &&
    (!hasActiveRouteIntent || !hasConfirmedAnalysisIntent) &&
    !showHistoryWhileActive &&
    !debateId &&
    !activeRunTask &&
    !hasFocusedRun &&
    !liveEntry &&
    !resolvedEntry;
  const showWorkspace =
    !showHistoryWhileActive &&
    !shouldShowPreview &&
    Boolean(liveIntentReady || liveEntry || resolvedEntry || hasFocusedRun);
  const activeTicker = useMemo(() => {
    if (focusedRunTask?.ticker) {
      return String(focusedRunTask.ticker).trim().toUpperCase();
    }
    if (activeRunTask?.ticker) {
      return String(activeRunTask.ticker).trim().toUpperCase();
    }
    if (liveIntentReady && analysisParams?.ticker) {
      return String(analysisParams.ticker).trim().toUpperCase();
    }
    return activeEntry?.ticker ? String(activeEntry.ticker).trim().toUpperCase() : "";
  }, [activeEntry?.ticker, activeRunTask?.ticker, analysisParams?.ticker, focusedRunTask?.ticker, liveIntentReady]);
  const previewTickerFromQuery = useMemo(() => {
    const rawTicker = String(searchParams.get("ticker") || "").trim().toUpperCase();
    if (!rawTicker) return "";
    if (showWorkspace) return "";
    return rawTicker;
  }, [searchParams, showWorkspace]);
  const analysisSuggestions = useMemo(() => {
    if (!userId || showWorkspace || previewTickerFromQuery || activeRunTask) {
      return [];
    }
    return getAnalysisSuggestions({
      userId,
      activeSymbol: activeTicker || null,
      previewSymbol: previewTickerFromQuery || null,
      recentSymbols: [activeEntry?.ticker, historyFallbackEntry?.ticker].filter(
        (ticker): ticker is string => typeof ticker === "string",
      ),
    });
  }, [
    activeEntry?.ticker,
    activeRunTask,
    activeTicker,
    historyFallbackEntry?.ticker,
    previewTickerFromQuery,
    showWorkspace,
    userId,
  ]);

  useEffect(() => {
    if (!shouldShowPreview || !hasActiveRouteIntent || !previewTickerRaw) return;
    router.replace(
      buildKaiAnalysisPreviewRoute({
        ticker: previewTickerRaw,
        pickSource: previewPickSourceFromQuery || previewPickSource,
      })
    );
  }, [
    hasActiveRouteIntent,
    previewPickSource,
    previewPickSourceFromQuery,
    previewTickerRaw,
    router,
    shouldShowPreview,
  ]);
  const analysisVoiceSurfaceMetadata = useMemo(() => {
    const workspaceTabLabel =
      workspaceTab === "debate"
        ? "Debate"
        : workspaceTab === "summary"
          ? "Summary"
          : "Detailed View";
    const surfaceMode = showWorkspace ? "workspace" : "history";
    const actions = [
      ...(showWorkspace
        ? [
            { id: "analysis.back_to_history", actionId: "analysis.back_to_history", label: "Back to history", purpose: "Return to saved analysis history." },
            { id: "analysis.open_debate_tab", actionId: "analysis.open_debate_tab", label: "Open debate tab", purpose: "Show the current debate." },
            { id: "analysis.open_summary_tab", actionId: "analysis.open_summary_tab", label: "Open summary tab", purpose: "Show the analysis summary." },
            { id: "analysis.open_detailed_tab", actionId: "analysis.open_detailed_tab", label: "Open detailed analysis", purpose: "Show the detailed review." },
            ...(liveIntentReady ? [{ id: "analysis.cancel_active", actionId: "analysis.cancel_active", label: "Cancel analysis", purpose: "Cancel the active analysis." }] : []),
          ]
        : [
            ...(previewTickerFromQuery ? [{ id: "analysis.confirm_preview", actionId: "analysis.confirm_preview", label: "Start debate from preview", purpose: "Confirm the visible preview before a debate begins." }] : []),
            ...(activeRunTask ? [{ id: "analysis.resume_active", actionId: "analysis.resume_active", label: "Open active analysis", purpose: "Resume the active analysis workspace." }] : []),
          ]),
    ];
    const sections = showWorkspace
      ? [
          {
            id: "debate",
            title: "Debate",
            purpose: "Shows the live or replayed analysis debate transcript.",
          },
          {
            id: "summary",
            title: "Summary",
            purpose: "Shows the current overall decision and compact analysis summary.",
          },
          {
            id: "detailed",
            title: "Detailed View",
            purpose: "Shows the deeper analysis breakdown and saved transcript context.",
          },
        ]
      : [
          {
            id: "history_dashboard",
            title: "Analysis history",
            purpose: "Shows saved debates, previews, and active-analysis return points.",
          },
        ];
    const controls = [
      ...(showWorkspace
        ? [
            { id: "analysis_back_to_history", label: "Back to history", purpose: "Return to history.", actionId: "analysis.back_to_history", role: "button" },
            { id: "analysis_tab_debate", label: "Debate tab", purpose: "Show the debate.", actionId: "analysis.open_debate_tab", role: "tab" },
            { id: "analysis_tab_summary", label: "Summary tab", purpose: "Show the summary.", actionId: "analysis.open_summary_tab", role: "tab" },
            { id: "analysis_tab_detailed", label: "Detailed tab", purpose: "Show detailed analysis.", actionId: "analysis.open_detailed_tab", role: "tab" },
            ...(liveIntentReady ? [{ id: "analysis_cancel", label: "Cancel analysis", purpose: "Cancel the active analysis.", actionId: "analysis.cancel_active", role: "button" }] : []),
          ]
        : [
            ...(previewTickerFromQuery ? [{ id: "analysis_start_preview", label: "Start debate", purpose: "Confirm the preview and begin the debate.", actionId: "analysis.confirm_preview", role: "button" }] : []),
            ...(activeRunTask ? [{ id: "analysis_open_active", label: "Open active analysis", purpose: "Resume the active analysis.", actionId: "analysis.resume_active", role: "button" }] : []),
          ]),
    ];
    const visibleModules = showWorkspace
      ? [
          "Ticker header",
          `${workspaceTabLabel} tab`,
          ...(workspaceTab === "debate"
            ? ["Debate workspace"]
            : workspaceTab === "summary"
              ? ["Summary workspace"]
              : ["Detailed review"]),
        ]
      : [
          ...(previewTickerFromQuery ? ["Stock preview"] : []),
          ...(activeRunTask ? ["Active analysis banner"] : []),
          "Analysis history",
        ];

    return {
      screenId: showWorkspace ? "kai_analysis_workspace" : "kai_analysis_history",
      title: "Analysis",
      purpose: showWorkspace
        ? "This workspace runs and reviews ticker analysis across debate, summary, and detailed views."
        : "This screen keeps saved analysis history, preview cards, and active-analysis return points in one place.",
      primaryEntity: activeTicker || previewTickerFromQuery || null,
      sections,
      actions,
      controls,
      concepts: [
        {
          id: "analysis",
          label: "Analysis",
          explanation: "Analysis is the research workspace for running and reviewing ticker debates.",
          aliases: ["analysis", "debate", "research"],
        },
      ],
      activeSection: showWorkspace ? workspaceTabLabel : "Analysis history",
      activeTab: showWorkspace ? workspaceTab : null,
      selectedEntity: activeTicker || previewTickerFromQuery || null,
      visibleModules,
      focusedWidget: showWorkspace ? `${workspaceTabLabel} tab` : "Analysis history",
      availableActions: actions.map((action) => action.label),
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(resolvingEntry ? ["analysis_entry_resolution"] : []),
        ...(headerSnapshotLoading ? ["analysis_header_snapshot"] : []),
        ...(stockPreviewLoading ? ["analysis_stock_preview"] : []),
        ...(activeRunTask ? ["analysis_active_run"] : []),
      ],
      screenMetadata: {
        surface_mode: surfaceMode,
        workspace_tab: workspaceTab,
        active_ticker: activeTicker || null,
        active_run_id: activeRunTask?.runId || null,
        focused_run_id: focusedRunTask?.runId || focusedRunId || null,
        selected_history_debate_id: debateId || extractDebateId(activeEntry) || null,
        can_start_new_run: canStartNewRun,
        live_intent_ready: liveIntentReady,
        has_active_run: Boolean(activeRunTask),
        has_focused_run: hasFocusedRun,
        has_live_entry: Boolean(liveEntry),
        has_resolved_entry: Boolean(resolvedEntry),
        history_fallback_entry_present: Boolean(historyFallbackEntry),
        show_history_while_active: showHistoryWhileActive,
        resolving_entry: resolvingEntry,
        header_snapshot_loading: headerSnapshotLoading,
        stock_preview_loading: stockPreviewLoading,
        stock_preview_error: stockPreviewError,
      },
    };
  }, [
    activeVoiceControlId,
    activeEntry,
    activeRunTask,
    activeTicker,
    canStartNewRun,
    debateId,
    focusedRunId,
    focusedRunTask,
    hasFocusedRun,
    headerSnapshotLoading,
    historyFallbackEntry,
    lastVoiceControlId,
    liveEntry,
    liveIntentReady,
    previewTickerFromQuery,
    resolvedEntry,
    resolvingEntry,
    showHistoryWhileActive,
    showWorkspace,
    stockPreviewError,
    stockPreviewLoading,
    workspaceTab,
  ]);
  usePublishVoiceSurfaceMetadata(analysisVoiceSurfaceMetadata);
  const handleStartDebateFromPreview = useCallback(() => {
    const currentPreviewTicker = previewTickerRaw;
    if (!currentPreviewTicker || !userId || showWorkspace || !vaultOwnerToken) return;
    if (activeRunTask?.runId) {
      showDebateAlreadyRunningToast(toast, {
        description: "Open the active debate before starting a new one.",
      });
      router.replace(buildKaiMarketRoute("analysis", { focus: "active" }));
      return;
    }
    setStartingPreviewDebate(true);
    void getStockContext(currentPreviewTicker, vaultOwnerToken)
      .then((context) => {
        setResolvedEntry(null);
        setLiveEntry(null);
        setFocusedRunId(null);
        setFocusedRunTask(null);
        setAnalysisParams({
          ticker: currentPreviewTicker,
          userId,
          riskProfile: context.user_risk_profile || "balanced",
          launchConfirmed: true,
          userContext: context,
          pickSource: previewPickSource,
        });
        setShowHistoryWhileActive(false);
        setWorkspaceTab("debate");
        router.replace(
          buildKaiMarketRoute("analysis", {
            focus: "active",
            ticker: currentPreviewTicker,
          }),
        );
      })
      .catch((error) => {
        toast.error("Could not start debate.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      })
      .finally(() => {
        setStartingPreviewDebate(false);
      });
  }, [
    previewPickSource,
    previewTickerRaw,
    activeRunTask?.runId,
    router,
    setAnalysisParams,
    showWorkspace,
    userId,
    vaultOwnerToken,
  ]);
  const handleBrowseRecommendations = useCallback(() => {
    setAnalysisParams(null);
    setHistoryFallbackEntry(null);
    setShowHistoryWhileActive(false);
    router.replace(buildKaiMarketRoute("analysis"), { scroll: false });
  }, [router, setAnalysisParams]);
  const handleChangePreviewStock = useCallback(() => {
    openKaiCommandBar();
  }, []);
  useLocalOnboardingActionHandler("analysis.back_to_history", () => {
    setAnalysisParams(null);
    setFocusedRunId(null);
    setFocusedRunTask(null);
    setShowHistoryWhileActive(true);
    setDebateIdParam(null);
    return { status: "succeeded", summary: "Analysis history opened." };
  });
  useLocalOnboardingActionHandler("analysis.open_debate_tab", () => {
    setWorkspaceView("debate");
    return { status: "succeeded", summary: "Debate opened." };
  });
  useLocalOnboardingActionHandler("analysis.open_summary_tab", () => {
    setWorkspaceView("summary");
    return { status: "succeeded", summary: "Summary tab opened." };
  });
  useLocalOnboardingActionHandler("analysis.open_detailed_tab", () => {
    setWorkspaceView("detailed");
    return { status: "succeeded", summary: "Detailed analysis opened." };
  });
  useLocalOnboardingActionHandler("analysis.cancel_active", () => {
    if (!liveIntentReady) return { status: "blocked", summary: "There is no active analysis to cancel." };
    handleCloseLiveDebate();
    return { status: "succeeded", summary: "Analysis cancelled." };
  });
  useLocalOnboardingActionHandler("analysis.resume_active", () => {
    if (!activeRunTask) return { status: "blocked", summary: "There is no active analysis to resume." };
    setFocusedRunId(activeRunTask.runId);
    setShowHistoryWhileActive(false);
    setWorkspaceTab("debate");
    return { status: "succeeded", summary: "Active analysis opened." };
  });
  useLocalOnboardingActionHandler("analysis.confirm_preview", () => {
    if (!previewTickerFromQuery) return { status: "blocked", summary: "Open a stock preview before starting a debate." };
    handleStartDebateFromPreview();
    return { status: "started", summary: "Starting the confirmed analysis debate." };
  });
  const headerPriceLabel =
    headerSnapshotLoading && (headerSnapshot?.last_price ?? null) === null
      ? "Loading price..."
      : formatCurrency(headerSnapshot?.last_price ?? null);
  const headerChangePct = headerSnapshot?.change_pct ?? null;

  useEffect(() => {
    if (!showWorkspace || !activeTicker || !userId) {
      setHeaderSnapshot(null);
      setHeaderSnapshotLoading(false);
      return;
    }

    let cancelled = false;
    const cached = getLatestMarketSnapshotFromCache(userId, activeTicker);
    setHeaderSnapshotLoading(Boolean(vaultOwnerToken) && !cached);
    if (!cancelled) {
      setHeaderSnapshot((prev) => pickPreferredMarketSnapshot(prev, cached));
    }

    if (!vaultOwnerToken) {
      setHeaderSnapshotLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const live = await fetchLatestMarketSnapshot({
          userId,
          ticker: activeTicker,
          vaultOwnerToken,
          daysBack: 7,
        });
        if (!cancelled) {
          setHeaderSnapshot((prev) => pickPreferredMarketSnapshot(prev, live));
        }
      } catch {
        // Keep best known cached value.
      } finally {
        if (!cancelled) {
          setHeaderSnapshotLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTicker, showWorkspace, userId, vaultOwnerToken]);

  useEffect(() => {
    if (!userId) {
      setPreviewPickSource("default");
      return;
    }
    const querySource = previewPickSourceFromQuery;
    if (querySource) {
      setPreviewPickSource(querySource);
      return;
    }
    setPreviewPickSource(getKaiActivePickSource(userId));
  }, [previewPickSourceFromQuery, userId]);

  useEffect(() => {
    if (!userId) return;
    setKaiActivePickSource(userId, previewPickSource);
  }, [previewPickSource, userId]);

  useEffect(() => {
    if (!previewTickerFromQuery || !userId || !vaultOwnerToken) {
      setStockPreview(null);
      setStockPreviewLoading(false);
      setStockPreviewError(null);
      return;
    }

    let cancelled = false;
    setStockPreviewLoading(true);
    setStockPreviewError(null);
    void (async () => {
      try {
        const payload = await ApiService.getKaiStockPreview({
          userId,
          symbol: previewTickerFromQuery,
          vaultOwnerToken,
          pickSource: previewPickSource,
        });
        if (!cancelled) {
          setStockPreview(payload);
          if (payload.active_pick_source && payload.active_pick_source !== previewPickSource) {
            setPreviewPickSource(payload.active_pick_source);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStockPreview(null);
          setStockPreviewError(
            error instanceof Error ? error.message : "Failed to load stock preview"
          );
        }
      } finally {
        if (!cancelled) {
          setStockPreviewLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewPickSource, previewTickerFromQuery, userId, vaultOwnerToken]);

  useEffect(() => {
    if (
      summaryLoadingToastIdRef.current !== null &&
      workspaceTab === "summary" &&
      resolvedEntry
    ) {
      toast.dismiss(summaryLoadingToastIdRef.current);
      toast.success("Summary ready.");
      summaryLoadingToastIdRef.current = null;
    }
  }, [resolvedEntry, workspaceTab]);

  useEffect(
    () => () => {
      if (summaryLoadingToastIdRef.current !== null) {
        toast.dismiss(summaryLoadingToastIdRef.current);
        summaryLoadingToastIdRef.current = null;
      }
    },
    []
  );

  if (localAnalysisPreview) {
    return <KaiAnalysisPreviewView />;
  }

  if (!user || !userId) {
    return (
      <AppPageShell as="div" width="standard" className="flex min-h-96 items-center justify-center">
        <NativeTestBeacon
          routeId={ROUTES.KAI_ANALYSIS}
          marker="native-route-kai-analysis"
          authState={user ? "authenticated" : "pending"}
          dataState="loading"
        />
        <HushhLoader variant="inline" label={toInvestorLoading("ANALYSIS")} />
      </AppPageShell>
    );
  }

  if (!vaultKey) {
    return (
      <AppPageShell as="div" width="reading">
        <NativeTestBeacon
          routeId={ROUTES.KAI_ANALYSIS}
          marker="native-route-kai-analysis"
          authState={user ? "authenticated" : "pending"}
          dataState="unavailable-valid"
          errorCode="vault_locked"
          errorMessage="Vault locked"
        />
        <SurfaceCard>
          <SurfaceCardContent className="p-5 text-center">
          <h2 className="text-lg font-semibold">Unlock your Vault to continue</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your portfolio and saved analysis stay encrypted in Vault. Unlock it to reopen analysis,
            review history, or start a new debate with your stored holdings context.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <MorphyButton onClick={() => router.push(ROUTES.KAI_HOME)}>
              Return to Kai
            </MorphyButton>
            <MorphyButton
              variant="none"
              effect="fade"
              onClick={() => router.push(ROUTES.KAI_PORTFOLIO)}
            >
              Open Portfolio
            </MorphyButton>
          </div>
          </SurfaceCardContent>
        </SurfaceCard>
      </AppPageShell>
    );
  }

  return (
    <>
      {showWorkspace ? (
        <div
          className="w-full min-w-0 max-w-full"
          data-testid={liveIntentReady ? "kai-analysis-active-run" : "kai-analysis-primary"}
        >
          <NativeTestBeacon
            routeId={ROUTES.KAI_ANALYSIS}
            marker="native-route-kai-analysis"
            authState={user ? "authenticated" : "pending"}
            dataState="loaded"
          />
          <KaiWorkspaceHeader
              workspace="analysis"
              title="Analysis"
              description="Review the live debate and detailed recommendation."
              actions={
                <>
                  {liveIntentReady ? (
                    <MorphyButton
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={handleCloseLiveDebate}
                      data-voice-control-id="analysis_cancel"
                    >
                      <Icon icon={X} size="xs" className="mr-1" />
                      Cancel
                    </MorphyButton>
                  ) : null}
                </>
              }
          />
          <AppPageContentRegion className="min-w-0 max-w-full">
            <div ref={workspaceTopRef} className="min-w-0 max-w-full">
              <SurfaceStack compact className="min-w-0 max-w-full">
            <SurfaceCard>
              <SurfaceCardContent className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <SymbolAvatar symbol={activeTicker} name={activeTicker} size="lg" />
                  <div
                    role="heading"
                    aria-level={2}
                    className="text-[20px] font-medium leading-tight tracking-normal text-foreground sm:text-[22px]"
                  >
                    {activeTicker}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tabular-nums text-muted-foreground sm:text-base">
                    {headerPriceLabel}
                  </span>
                  {headerChangePct !== null ? (
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-medium tabular-nums",
                        headerChangePct >= 0
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      )}
                    >
                      {headerChangePct >= 0 ? "+" : ""}
                      {headerChangePct.toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Today --</span>
                  )}
                </div>
              </div>
              </SurfaceCardContent>
            </SurfaceCard>
            <div className="w-full min-w-0 max-w-full">
              <div className="mx-auto flex justify-center w-full" style={APP_MEASURE_STYLES.reading}>
                <SegmentedTabs
                  value={workspaceTab}
                  onValueChange={handleWorkspaceTabChange}
                  options={workspaceTabOptions}
                  className="mx-auto w-full"
                />
              </div>
              <SwipeViews
                tabSetId="analysis-workspace"
                activeValue={workspaceTab}
                options={workspaceTabOptions}
                onSelectionChange={(value) => setWorkspaceTab(value as WorkspaceTab)}
                onSelectionCommit={(value) => setWorkspaceView(value as WorkspaceTab)}
              >
              <div className="mt-4 min-w-0 max-w-full">
                {activeRunTask ? (
                  <DebateStreamView
                    runId={activeRunTask.runId}
                    ticker={activeRunTask.ticker}
                    userId={activeRunTask.userId}
                    riskProfile={analysisParams?.riskProfile || "balanced"}
                    vaultOwnerToken={vaultOwnerToken || ""}
                    vaultKey={vaultKey}
                    portfolioContextOverride={analysisParams?.portfolioContext || null}
                    portfolioSource={analysisParams?.portfolioSource}
                    pickSource={analysisParams?.pickSource}
                    onClose={handleCloseLiveDebate}
                    onDecisionReady={handleLiveDecisionReady}
                    onDecisionPersisted={handleLiveDecisionPersisted}
                    showHeader={false}
                  />
                ) : focusedRunTask ? (
                  <DebateStreamView
                    runId={focusedRunTask.runId}
                    ticker={focusedRunTask.ticker}
                    userId={focusedRunTask.userId}
                    riskProfile={analysisParams?.riskProfile || "balanced"}
                    vaultOwnerToken={vaultOwnerToken || ""}
                    vaultKey={vaultKey}
                    portfolioContextOverride={analysisParams?.portfolioContext || null}
                    portfolioSource={analysisParams?.portfolioSource}
                    pickSource={analysisParams?.pickSource}
                    onClose={handleCloseLiveDebate}
                    onDecisionReady={handleLiveDecisionReady}
                    onDecisionPersisted={handleLiveDecisionPersisted}
                    showHeader={false}
                  />
                ) : canStartNewRun && analysisParams ? (
                  <DebateStreamView
                    ticker={analysisParams.ticker}
                    userId={analysisParams.userId}
                    riskProfile={analysisParams.riskProfile}
                    vaultOwnerToken={vaultOwnerToken || ""}
                    vaultKey={vaultKey}
                    portfolioContextOverride={analysisParams?.portfolioContext || null}
                    portfolioSource={analysisParams?.portfolioSource}
                    pickSource={analysisParams?.pickSource}
                    onClose={handleCloseLiveDebate}
                    onDecisionReady={handleLiveDecisionReady}
                    onDecisionPersisted={handleLiveDecisionPersisted}
                    showHeader={false}
                  />
                ) : activeEntry ? (
                  <HistoryDebateReplay entry={activeEntry} />
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground">
                    {toInvestorMessage("ANALYSIS_UNAVAILABLE", { ticker: activeTicker })}
                  </div>
                )}
              </div>
              <div className="mt-4 min-w-0 max-w-full">
                {activeEntry ? (
                  <div className="space-y-3">
                    {focusedRunTask?.persistenceState === "pending" ? (
                      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                        Kai is saving this debate to your PKM history.
                      </div>
                    ) : null}
                    {focusedRunTask?.persistenceState === "failed" ? (
                      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span>{focusedRunTask.persistenceError || "History save failed for this debate."}</span>
                          <MorphyButton
                            size="sm"
                            data-voice-control-id="analysis_retry_save"
                            onClick={() => void DebateRunManagerService.retryTaskPersistence(focusedRunTask.runId)}
                          >
                            Retry save
                          </MorphyButton>
                        </div>
                      </div>
                    ) : null}
                    <AnalysisSummaryView
                      entry={activeEntry}
                      onReanalyze={handleReanalyze}
                      embedded
                      userId={userId}
                      vaultOwnerToken={vaultOwnerToken || undefined}
                      showHeader={false}
                    />
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground">
                    Your summary will appear as soon as the first recommendation is ready.
                  </div>
                )}
              </div>
              <div className="mt-4 min-w-0 max-w-full">
                {activeEntry ? (
                  <HistoryDetailView
                    entry={activeEntry}
                    onReanalyze={handleReanalyze}
                    embedded
                    userId={userId}
                    vaultOwnerToken={vaultOwnerToken || undefined}
                    showHeader={false}
                  />
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground">
                    Detailed analysis will appear once the first recommendation is complete.
                  </div>
                )}
              </div>
              </SwipeViews>
            </div>
              </SurfaceStack>
            </div>
          </AppPageContentRegion>
        </div>
      ) : !resolvingEntry ? (
        <div className="w-full min-w-0 max-w-full" data-testid="kai-analysis-primary">
          <NativeTestBeacon
            routeId={ROUTES.KAI_ANALYSIS}
            marker="native-route-kai-analysis"
            authState={user ? "authenticated" : "pending"}
            dataState={stockPreviewLoading ? "loading" : "loaded"}
            errorCode={stockPreviewError ? "stock_preview" : null}
            errorMessage={stockPreviewError}
          />
          <KaiWorkspaceHeader
              workspace="analysis"
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Analysis
                  {historyCount > 0 ? (
                    <Badge variant="secondary" className="text-[10px]">{historyCount}</Badge>
                  ) : null}
                </span>
              }
              description="Review saved debates and reopen a previous decision."
          />
          <AppPageContentRegion className="min-w-0 max-w-full">
            <SurfaceStack compact className="min-w-0 max-w-full">
          {analysisSuggestions.length > 0 ? (
            <SurfaceCard className="w-full">
              <SurfaceCardContent className="flex flex-col gap-3 px-3 py-3">
                <button
                  type="button"
                  onClick={() => openKaiCommandBar()}
                  className="flex h-9 w-full items-center gap-2 rounded-full border border-border/70 px-3.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  <Icon icon={Search} size="sm" className="shrink-0" />
                  Search any stock to analyze
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs font-medium text-muted-foreground">
                    Research starters
                  </span>
                  {analysisSuggestions.map((suggestion) => (
                    <MorphyButton
                      key={suggestion.symbol}
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="h-8 rounded-full border border-border/70 pl-1.5 pr-3 text-xs text-foreground hover:bg-muted"
                      onClick={() => handleSelectTicker(suggestion.symbol)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <SymbolAvatar symbol={suggestion.symbol} size="sm" />
                        {suggestion.symbol}
                      </span>
                    </MorphyButton>
                  ))}
                </div>
              </SurfaceCardContent>
            </SurfaceCard>
          ) : null}
          {previewTickerFromQuery ? (
            <StockComparisonPreview
              preview={stockPreview}
              loading={stockPreviewLoading}
              error={stockPreviewError}
              onStartDebate={handleStartDebateFromPreview}
              onBrowseRecommendations={handleBrowseRecommendations}
              onChangeStock={handleChangePreviewStock}
              activePickSource={previewPickSource}
              onPickSourceChange={setPreviewPickSource}
              compact
              starting={startingPreviewDebate}
            />
          ) : null}
          {activeRunTask ? (
            <SurfaceCard accent="sky" className="w-full">
              <SurfaceCardContent className="px-3 py-2 text-xs text-accent-strong">
              Analysis for <span className="font-semibold">{activeRunTask.ticker}</span> is still
              running in the background.
              <MorphyButton
                variant="none"
                effect="fade"
                size="sm"
                className="ml-2 h-7 px-2 text-xs"
                data-voice-control-id="analysis_open_active"
                onClick={() => {
                  if (activeRunTask?.runId) {
                    setFocusedRunId(activeRunTask.runId);
                  }
                  setShowHistoryWhileActive(false);
                  setWorkspaceTab("debate");
                  requestAnimationFrame(() => {
                    workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
                  });
                }}
              >
                Open active analysis
              </MorphyButton>
              </SurfaceCardContent>
            </SurfaceCard>
          ) : null}
          <AnalysisHistoryDashboard
            userId={userId}
            vaultKey={vaultKey}
            vaultOwnerToken={vaultOwnerToken || ""}
            onSelectTicker={handleSelectTicker}
            onViewHistory={handleViewHistory}
            onHistoryCount={setHistoryCount}
            showDebateInputs={false}
            ephemeralEntry={historyFallbackEntry}
          />
            </SurfaceStack>
          </AppPageContentRegion>
        </div>
      ) : null}

      {resolvingEntry ? (
        <AppPageShell as="div" width="standard" className="flex min-h-64 items-center justify-center">
          <HushhLoader variant="inline" label="Loading saved analysis..." />
        </AppPageShell>
      ) : null}
    </>
  );
}

export default function KaiAnalysisPage() {
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  const legacyTab = params.get("tab");
  if (legacyTab && ["history", "debate", "summary", "transcript"].includes(legacyTab)) {
    params.set("view", legacyTab);
  }
  params.delete("tab");
  return (
    <Suspense fallback={<HushhLoader label="Loading analysis..." variant="fullscreen" />}>
      <ClientRedirect to={buildKaiMarketRoute("analysis", Object.fromEntries(params.entries()))} />
    </Suspense>
  );
}
