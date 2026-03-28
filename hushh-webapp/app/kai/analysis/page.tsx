"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BarChart3, X } from "lucide-react";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { PageHeader } from "@/components/app-ui/page-sections";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SurfaceCard, SurfaceCardContent, SurfaceStack } from "@/components/app-ui/surfaces";
import { DebateStreamView, type AgentState } from "@/components/kai/debate-stream-view";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { AnalysisHistoryDashboard } from "@/components/kai/views/analysis-history-dashboard";
import { AnalysisSummaryView } from "@/components/kai/views/analysis-summary-view";
import { HistoryDetailView } from "@/components/kai/views/history-detail-view";
import { StockComparisonPreview } from "@/components/kai/cards/stock-comparison-preview";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { getKaiActivePickSource } from "@/lib/kai/pick-source-selection";

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
      <div className="mx-auto max-w-2xl rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground">
        Debate transcript unavailable for this run.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 pb-safe">
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
  const [activeRunTask, setActiveRunTask] = useState<DebateRunTask | null>(null);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [focusedRunTask, setFocusedRunTask] = useState<DebateRunTask | null>(null);
  const [showHistoryWhileActive, setShowHistoryWhileActive] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("debate");
  const [headerSnapshot, setHeaderSnapshot] = useState<TickerMarketSnapshot | null>(null);
  const [headerSnapshotLoading, setHeaderSnapshotLoading] = useState(false);
  const [stockPreview, setStockPreview] = useState<KaiStockPreviewResponse | null>(null);
  const [stockPreviewLoading, setStockPreviewLoading] = useState(false);
  const [stockPreviewError, setStockPreviewError] = useState<string | null>(null);

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
    const hasTabParam = searchParams.has("tab");
    const focus = searchParams.get("focus");
    const hasFocusActive = focus === "active";
    const hasRunIdParam = searchParams.has("run_id");
    const runIdParam = searchParams.get("run_id");
    if (!hasTabParam && !hasFocusActive && !hasRunIdParam) return;

    if (hasFocusActive || hasRunIdParam) {
      if (runIdParam && runIdParam.trim()) {
        setFocusedRunId(runIdParam.trim());
      }
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      requestAnimationFrame(() => {
        workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      });
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
    if (liveIntentReady) {
      setWorkspaceTab("debate");
    }
  }, [liveIntentReady]);

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
      if (!userId) return;
      setResolvedEntry(null);
      setLiveEntry(null);
      setFocusedRunId(null);
      setFocusedRunTask(null);
      setAnalysisParams({
        ticker,
        userId,
        riskProfile: "balanced",
      });
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      setDebateIdParam(null);
    },
    [setAnalysisParams, setDebateIdParam, userId]
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
      if (!userId) return;
      setResolvedEntry(null);
      setLiveEntry(null);
      setFocusedRunId(null);
      setFocusedRunTask(null);
      setAnalysisParams({
        ticker,
        userId,
        riskProfile: "balanced",
      });
      setShowHistoryWhileActive(false);
      setWorkspaceTab("debate");
      setDebateIdParam(null);
    },
    [setAnalysisParams, setDebateIdParam, userId]
  );

  const handleWorkspaceTabChange = useCallback((value: string) => {
    setWorkspaceTab(value as WorkspaceTab);
    requestAnimationFrame(() => {
      workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, []);

  const handleLiveDecisionSaved = useCallback(
    (entry: AnalysisHistoryEntry) => {
      if (summaryLoadingToastIdRef.current === null) {
        summaryLoadingToastIdRef.current = toast.info("Preparing summary…", {
          duration: Infinity,
          description: "Final recommendation is ready. Loading summary view.",
        });
      }
      setLiveEntry(entry);
      setResolvedEntry(entry);
      setAnalysisParams(null);
      setShowHistoryWhileActive(false);
      setWorkspaceTab("summary");
      requestAnimationFrame(() => {
        workspaceTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      });
    },
    [setAnalysisParams]
  );

  const hasFocusedRun = Boolean(focusedRunTask && !focusedRunTask.dismissedAt);
  const activeEntry = liveIntentReady ? liveEntry : resolvedEntry;
  const showWorkspace = !showHistoryWhileActive && Boolean(liveIntentReady || resolvedEntry || hasFocusedRun);
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
  const handleStartDebateFromPreview = useCallback(() => {
    const currentPreviewTicker = String(searchParams.get("ticker") || "").trim().toUpperCase();
    if (!currentPreviewTicker || !userId || showWorkspace) return;
    setResolvedEntry(null);
    setLiveEntry(null);
    setFocusedRunId(null);
    setFocusedRunTask(null);
    setAnalysisParams({
      ticker: currentPreviewTicker,
      userId,
      riskProfile: "balanced",
    });
    setShowHistoryWhileActive(false);
    setWorkspaceTab("debate");
  }, [searchParams, setAnalysisParams, showWorkspace, userId]);
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
          pickSource: getKaiActivePickSource(userId),
        });
        if (!cancelled) {
          setStockPreview(payload);
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
  }, [previewTickerFromQuery, userId, vaultOwnerToken]);

  useEffect(() => {
    if (
      summaryLoadingToastIdRef.current !== null &&
      workspaceTab === "summary" &&
      activeEntry
    ) {
      toast.dismiss(summaryLoadingToastIdRef.current);
      toast.success("Summary ready.");
      summaryLoadingToastIdRef.current = null;
    }
  }, [activeEntry, workspaceTab]);

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
      <AppPageShell as="div" width="content" className="flex min-h-96 items-center justify-center">
        <HushhLoader variant="inline" label={toInvestorLoading("ANALYSIS")} />
      </AppPageShell>
    );
  }

  if (!vaultKey) {
    return (
      <AppPageShell as="div" width="narrow">
        <SurfaceCard>
          <SurfaceCardContent className="p-5 text-center">
          <h2 className="text-lg font-semibold">Connect your portfolio first</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Stock analysis is available after your portfolio is saved in Vault.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <MorphyButton onClick={() => router.push("/kai/import")}>
              Open Import
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
        <AppPageShell as="div" width="wide">
          <AppPageHeaderRegion>
            <PageHeader
              eyebrow="Kai Analysis"
              title="Analysis"
              description="Move between live debate, summary, and detailed review without losing the current ticker context."
              icon={BarChart3}
              accent="violet"
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
                <h1 className="text-2xl font-black tracking-tighter text-foreground sm:text-3xl">
                  {activeTicker}
                </h1>
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
              <div className="flex justify-center">
                <TabsList className="mx-auto grid h-auto w-full max-w-xl grid-cols-1 gap-1 p-1 min-[430px]:grid-cols-3">
                  <TabsTrigger value="debate" className="min-h-10 whitespace-normal px-3 py-2 text-center">
                    Debate
                  </TabsTrigger>
                  <TabsTrigger value="summary" className="min-h-10 whitespace-normal px-3 py-2 text-center">
                    Summary
                  </TabsTrigger>
                  <TabsTrigger value="detailed" className="min-h-10 whitespace-normal px-3 py-2 text-center">
                    Detailed View
                  </TabsTrigger>
                </TabsList>
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
                    onClose={handleCloseLiveDebate}
                    onDecisionSaved={handleLiveDecisionSaved}
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
                    onClose={handleCloseLiveDebate}
                    onDecisionSaved={handleLiveDecisionSaved}
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
                    onClose={handleCloseLiveDebate}
                    onDecisionSaved={handleLiveDecisionSaved}
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
                  <AnalysisSummaryView
                    entry={activeEntry}
                    onReanalyze={handleReanalyze}
                    embedded
                    userId={userId}
                    vaultOwnerToken={vaultOwnerToken || undefined}
                    showHeader={false}
                  />
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
        <AppPageShell as="div" width="wide">
          <AppPageHeaderRegion>
            <PageHeader
              eyebrow="Kai Analysis"
              title="Analysis"
              description="Review saved debates, reopen active analysis, and keep the running history of Kai decisions in one place."
              icon={BarChart3}
              accent="violet"
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
              onOpenFullAnalysis={handleStartDebateFromPreview}
              showOpenFullAnalysis={false}
              compact
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
            showDebateInputs={false}
          />
            </SurfaceStack>
          </AppPageContentRegion>
        </AppPageShell>
      ) : null}

      {resolvingEntry ? (
        <AppPageShell as="div" width="content" className="flex min-h-64 items-center justify-center">
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
