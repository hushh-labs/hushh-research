"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BarChart3, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { PageHeader } from "@/components/app-ui/page-sections";
import {
  APP_MEASURE_STYLES,
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SurfaceCard, SurfaceCardContent, SurfaceStack } from "@/components/app-ui/surfaces";
import { DebateStreamView, type AgentState } from "@/components/kai/debate-stream-view";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { AnalysisHistoryDashboard } from "@/components/kai/views/analysis-history-dashboard";
import { AnalysisSummaryView } from "@/components/kai/views/analysis-summary-view";
import { HistoryDetailView } from "@/components/kai/views/history-detail-view";
import { StockComparisonPreview } from "@/components/kai/cards/stock-comparison-preview";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon, SegmentedTabs } from "@/lib/morphy-ux/ui";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/lib/firebase/auth-context";
import { KaiHistoryService, type AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
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
import { getStockContext } from "@/lib/services/kai-service";
import { buildKaiAnalysisPreviewRoute, ROUTES } from "@/lib/navigation/routes";

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
        description="Agents analyzed raw data independently."
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

function KaiAnalysisPageContent() {
  const pageOpenedAtRef = useRef(Date.now());
  const workspaceTopRef = useRef<HTMLDivElement | null>(null);
  const summaryLoadingToastIdRef = useRef<string | number | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();

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
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("debate");
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
      const query = params.toString();
      router.replace(query ? `/kai/analysis?${query}` : "/kai/analysis");
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

    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    params.delete("focus");
    params.delete("run_id");
    const query = params.toString();
    router.replace(query ? `/kai/analysis?${query}` : "/kai/analysis");
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

  const handleBackToHistory = useCallback(() => {
    setAnalysisParams(null);
    setLiveEntry(null);
    setResolvedEntry(null);
    setFocusedRunId(null);
    setFocusedRunTask(null);
    setShowHistoryWhileActive(true);
    setDebateIdParam(null);
  }, [setAnalysisParams, setDebateIdParam]);

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

  const handleWorkspaceTabChange = useCallback((value: string) => {
    setWorkspaceTab(value as WorkspaceTab);
    requestAnimationFrame(() => {
      workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, []);

  const handleLiveDecisionReady = useCallback(
    (entry: AnalysisHistoryEntry, meta: { runId: string | null }) => {
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
    [setAnalysisParams]
  );

  const handleLiveDecisionPersisted = useCallback((entry: AnalysisHistoryEntry) => {
    setLiveEntry(entry);
    setResolvedEntry(entry);
    setHistoryFallbackEntry(entry);
    setShowHistoryWhileActive(false);
    setWorkspaceTab((prev) => (prev === "debate" ? "summary" : prev));
    if (summaryLoadingToastIdRef.current !== null) {
      toast.dismiss(summaryLoadingToastIdRef.current);
      summaryLoadingToastIdRef.current = null;
    }
    toast.success("Analysis saved to history.");
  }, []);

  const hasFocusedRun = Boolean(focusedRunTask && !focusedRunTask.dismissedAt);
  const activeEntry = liveEntry || resolvedEntry;
  const previewTickerRaw = useMemo(
    () => String(searchParams.get("ticker") || "").trim().toUpperCase(),
    [searchParams]
  );
  const previewPickSourceFromQuery = useMemo(
    () => String(searchParams.get("pick_source") || "").trim(),
    [searchParams]
  );
  const shouldShowPreview =
    Boolean(previewTickerRaw) &&
    !showHistoryWhileActive &&
    !debateId &&
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
  const previewTickerFromQuery = shouldShowPreview ? previewTickerRaw : "";
  const handleStartDebateFromPreview = useCallback(() => {
    const currentPreviewTicker = previewTickerRaw;
    if (!currentPreviewTicker || !userId || showWorkspace || !vaultOwnerToken) return;
    if (activeRunTask?.runId) {
      toast.info("A debate is already running.", {
        description: "Open the active debate before starting a new one.",
      });
      router.replace(`${ROUTES.KAI_ANALYSIS}?focus=active`);
      return;
    }
    const previewSource =
      stockPreview?.pick_sources.find((source) => source.id === previewPickSource) ?? null;
    const resolvedPickSourceLabel =
      previewSource?.label ||
      (previewPickSource === "default"
        ? "Default list"
        : previewPickSource.startsWith("ria:")
          ? "Connected advisor list"
          : previewPickSource);

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
          userContext: context,
          pickSource: previewPickSource,
          pickSourceLabel: resolvedPickSourceLabel,
        });
        setShowHistoryWhileActive(false);
        setWorkspaceTab("debate");
        router.replace(ROUTES.KAI_ANALYSIS);
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
    stockPreview?.pick_sources,
    userId,
    vaultOwnerToken,
  ]);
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

  if (!user || !userId) {
    return (
      <AppPageShell as="div" width="standard" className="flex min-h-96 items-center justify-center">
        <NativeTestBeacon
          routeId="/kai/analysis"
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
          routeId="/kai/analysis"
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
            <MorphyButton onClick={() => router.push("/kai")}>
              Return to Kai
            </MorphyButton>
            <MorphyButton
              variant="none"
              effect="fade"
              onClick={() => router.push("/kai/portfolio")}
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
        <AppPageShell as="div" width="expanded" data-testid="kai-analysis-primary">
          <NativeTestBeacon
            routeId="/kai/analysis"
            marker="native-route-kai-analysis"
            authState={user ? "authenticated" : "pending"}
            dataState="loaded"
          />
          <AppPageHeaderRegion>
            <PageHeader
              eyebrow="Kai"
              title="Analysis"
              description="Move between live debate, summary, and detailed review without losing the current ticker context."
              icon={BarChart3}
              accent="kai"
              actions={
                <>
                  <MorphyButton variant="none" effect="fade" size="sm" onClick={handleBackToHistory}>
                    <Icon icon={ArrowLeft} size="sm" className="mr-1" />
                    Back to history
                  </MorphyButton>
                  {liveIntentReady ? (
                    <MorphyButton variant="none" effect="fade" size="sm" onClick={handleCloseLiveDebate}>
                      <Icon icon={X} size="xs" className="mr-1" />
                      Cancel
                    </MorphyButton>
                  ) : null}
                </>
              }
            />
          </AppPageHeaderRegion>
          <AppPageContentRegion>
            <div ref={workspaceTopRef}>
              <SurfaceStack compact>
            <SurfaceCard>
              <SurfaceCardContent className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <SymbolAvatar symbol={activeTicker} name={activeTicker} size="lg" />
                  <h1 className="text-2xl font-black tracking-tighter text-foreground sm:text-3xl">
                    {activeTicker}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums text-muted-foreground sm:text-base">
                    {headerPriceLabel}
                  </span>
                  {headerChangePct !== null ? (
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
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
            <Tabs
              value={workspaceTab}
              onValueChange={handleWorkspaceTabChange}
              className="w-full"
            >
              <div className="mx-auto flex justify-center w-full" style={APP_MEASURE_STYLES.reading}>
                <SegmentedTabs
                  value={workspaceTab}
                  onValueChange={handleWorkspaceTabChange}
                  options={[
                    { value: "debate", label: "Debate" },
                    { value: "summary", label: "Summary" },
                    { value: "detailed", label: "Detailed View" },
                  ]}
                  className="mx-auto w-full"
                />
              </div>
              <TabsContent value="debate" className="mt-4 data-[state=inactive]:hidden" forceMount>
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
                    pickSourceLabel={analysisParams?.pickSourceLabel}
                    pickSourceKind={analysisParams?.pickSource?.startsWith("ria:") ? "ria" : "default"}
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
                    pickSourceLabel={analysisParams?.pickSourceLabel}
                    pickSourceKind={analysisParams?.pickSource?.startsWith("ria:") ? "ria" : "default"}
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
                    pickSourceLabel={analysisParams?.pickSourceLabel}
                    pickSourceKind={analysisParams?.pickSource?.startsWith("ria:") ? "ria" : "default"}
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
              </TabsContent>
              <TabsContent value="summary" className="mt-4">
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
              </TabsContent>
              <TabsContent value="detailed" className="mt-4">
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
              </TabsContent>
            </Tabs>
              </SurfaceStack>
            </div>
          </AppPageContentRegion>
        </AppPageShell>
      ) : !resolvingEntry ? (
        <AppPageShell as="div" width="expanded" data-testid="kai-analysis-primary">
          <NativeTestBeacon
            routeId="/kai/analysis"
            marker="native-route-kai-analysis"
            authState={user ? "authenticated" : "pending"}
            dataState={stockPreviewLoading ? "loading" : "loaded"}
            errorCode={stockPreviewError ? "stock_preview" : null}
            errorMessage={stockPreviewError}
          />
          <AppPageHeaderRegion>
            <PageHeader
              eyebrow="Kai"
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Analysis
                  {historyCount > 0 ? (
                    <Badge variant="secondary" className="text-[10px]">{historyCount}</Badge>
                  ) : null}
                </span>
              }
              description="Review saved debates, reopen active analysis, and keep the running history of Kai decisions in one place."
              icon={BarChart3}
              accent="kai"
            />
          </AppPageHeaderRegion>
          <AppPageContentRegion>
            <SurfaceStack compact>
          {previewTickerFromQuery ? (
            <StockComparisonPreview
              preview={stockPreview}
              loading={stockPreviewLoading}
              error={stockPreviewError}
              onStartDebate={handleStartDebateFromPreview}
              activePickSource={previewPickSource}
              onPickSourceChange={setPreviewPickSource}
              compact
              starting={startingPreviewDebate}
            />
          ) : null}
          {activeRunTask ? (
            <SurfaceCard accent="sky" className="w-full">
              <SurfaceCardContent className="px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
              Analysis for <span className="font-semibold">{activeRunTask.ticker}</span> is still
              running in the background.
              <MorphyButton
                variant="none"
                effect="fade"
                size="sm"
                className="ml-2 h-7 px-2 text-xs"
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
        </AppPageShell>
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
  return (
    <Suspense fallback={<HushhLoader label="Loading analysis..." variant="fullscreen" />}>
      <KaiAnalysisPageContent />
    </Suspense>
  );
}
