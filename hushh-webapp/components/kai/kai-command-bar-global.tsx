"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { KaiSearchBar } from "@/components/kai/kai-search-bar";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { useVault } from "@/lib/vault/vault-context";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { executeKaiCommand } from "@/lib/kai/command-executor";
import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { executeVoiceResponse } from "@/lib/voice/voice-response-executor";
import { useVoiceSession } from "@/lib/voice/voice-session-store";
import type { GroundedVoicePlan } from "@/lib/voice/voice-grounding";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { isVoiceEligibleRouteScreen } from "@/lib/voice/voice-route-eligibility";
import type { AppRuntimeState, VoiceMemoryHint, VoiceResponse } from "@/lib/voice/voice-types";
import { ApiService } from "@/lib/services/api-service";

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function computeAnalyzeEligibilityFromHolding(holding: Record<string, unknown>): boolean {
  const isInvestable = toBoolean(holding.is_investable) === true;
  if (!isInvestable) return false;

  const listingStatus = String(holding.security_listing_status || "")
    .trim()
    .toLowerCase();
  const symbolKind = String(holding.symbol_kind || "")
    .trim()
    .toLowerCase();
  const isSecCommon = toBoolean(holding.is_sec_common_equity_ticker) === true;

  if (listingStatus === "non_sec_common_equity") return false;
  if (listingStatus === "fixed_income") return false;
  if (listingStatus === "cash_or_sweep") return false;

  if (isSecCommon) return true;
  if (listingStatus === "sec_common_equity") return true;
  if (symbolKind === "us_common_equity_ticker") return true;

  return false;
}

export function KaiCommandBarGlobal() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken, vaultKey, tokenExpiresAt } = useVault();
  const handleBack = useCallback(() => {
    router.back();
  }, [router]);
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const busyOperations = useKaiSession((s) => s.busyOperations);
  const analysisParams = useKaiSession((s) => s.analysisParams);
  const appendVoiceDebugEvent = useVoiceSession((s) => s.appendDebugEvent);
  const setPendingConfirmation = useVoiceSession((s) => s.setPendingConfirmation);
  const { lastToolName, lastTicker, setLastVoiceTurn } = useVoiceSession();
  const cache = useMemo(() => CacheService.getInstance(), []);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState()
  );
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const userId = user?.uid ?? "";
  const [voiceCapabilityState, setVoiceCapabilityState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    enabled: boolean;
    reason: string | null;
  }>({
    status: "idle",
    enabled: false,
    reason: null,
  });

  useEffect(() => {
    const unsubscribe = AppBackgroundTaskService.subscribe((state) => {
      setBackgroundTaskState(state);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setHasPortfolioData(false);
      return;
    }

    const computeHasPortfolioFromCache = (): boolean | null => {
      const cachedPortfolio = cache.get<Record<string, unknown>>(
        CACHE_KEYS.PORTFOLIO_DATA(user.uid)
      );
      if (!cachedPortfolio || typeof cachedPortfolio !== "object") {
        return null;
      }
      const nestedPortfolio =
        cachedPortfolio.portfolio &&
        typeof cachedPortfolio.portfolio === "object" &&
        !Array.isArray(cachedPortfolio.portfolio)
          ? (cachedPortfolio.portfolio as Record<string, unknown>)
          : null;
      const holdings = (Array.isArray(cachedPortfolio.holdings) && cachedPortfolio.holdings
        ? cachedPortfolio.holdings
        : Array.isArray(nestedPortfolio?.holdings)
          ? nestedPortfolio.holdings
        : []) as Array<Record<string, unknown>>;
      return holdings.length > 0;
    };

    let cancelled = false;

    const computeHasPortfolio = () => {
      const cachedHasPortfolio = computeHasPortfolioFromCache();
      if (cachedHasPortfolio !== null) {
        if (!cancelled) {
          setHasPortfolioData(cachedHasPortfolio);
        }
        return;
      }

      if (!cancelled) {
        setHasPortfolioData(false);
      }
    };

    computeHasPortfolio();
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "set" || event.type === "invalidate" || event.type === "invalidate_user" || event.type === "clear") {
        computeHasPortfolio();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [cache, user?.uid]);

  const reviewScreenActive = Boolean(
    busyOperations["portfolio_review_active"] || busyOperations["portfolio_save"]
  );
  const reviewDirty = Boolean(
    busyOperations["portfolio_review_active"] && busyOperations["portfolio_review_dirty"]
  );

  const portfolioTickers = useMemo(() => {
    if (!user?.uid) return [] as Array<{
      symbol: string;
      name?: string;
      sector?: string;
      asset_type?: string;
      is_investable?: boolean;
      analyze_eligible?: boolean;
    }>;

    const cachedPortfolio =
      cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(user.uid)) ??
      cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(user.uid, "financial"));
    const nestedPortfolio =
      cachedPortfolio?.portfolio &&
      typeof cachedPortfolio.portfolio === "object" &&
      !Array.isArray(cachedPortfolio.portfolio)
        ? (cachedPortfolio.portfolio as Record<string, unknown>)
        : null;
    const holdings = (
      (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
      (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
      []
    ) as Array<Record<string, unknown>>;

    const deduped = new Map<
      string,
      {
        symbol: string;
        name?: string;
        sector?: string;
        asset_type?: string;
        is_investable?: boolean;
        analyze_eligible?: boolean;
      }
    >();
    for (const holding of holdings) {
      const symbol = String(holding.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (deduped.has(symbol)) continue;
      deduped.set(symbol, {
        symbol,
        name: holding.name ? String(holding.name) : undefined,
        sector: holding.sector ? String(holding.sector) : undefined,
        asset_type: holding.asset_type ? String(holding.asset_type) : undefined,
        is_investable: typeof holding.is_investable === "boolean" ? holding.is_investable : undefined,
        analyze_eligible: computeAnalyzeEligibilityFromHolding(holding),
      });
    }
    return Array.from(deduped.values());
  }, [cache, user?.uid]);

  const signedIn = Boolean(user?.uid);
  const tokenAvailable = Boolean(vaultOwnerToken);
  const tokenValid = Boolean(vaultOwnerToken) && (!tokenExpiresAt || tokenExpiresAt > Date.now());
  const localVoiceReady = signedIn && isVaultUnlocked && tokenAvailable && tokenValid;
  const routeQuery = searchParams?.toString() || "";
  const pathnameWithQuery = routeQuery ? `${pathname || ""}?${routeQuery}` : pathname || "";
  const routeInfo = useMemo(
    () => deriveVoiceRouteScreen(pathname || "", routeQuery),
    [pathname, routeQuery]
  );
  const voiceEligibleRoute = isVoiceEligibleRouteScreen(routeInfo.screen, chromeState.hideCommandBar);

  useEffect(() => {
    if (!voiceEligibleRoute) {
      setVoiceCapabilityState({
        status: "idle",
        enabled: false,
        reason: null,
      });
      return;
    }
    if (!localVoiceReady || !userId || !vaultOwnerToken) {
      setVoiceCapabilityState({
        status: "idle",
        enabled: false,
        reason: null,
      });
      return;
    }

    let cancelled = false;
    setVoiceCapabilityState((current) => ({
      status: "loading",
      enabled: current.enabled,
      reason: current.reason,
    }));

    void ApiService.getKaiVoiceCapabilityJson({
      userId,
      vaultOwnerToken,
    })
      .then((capability) => {
        if (cancelled) return;
        setVoiceCapabilityState({
          status: "ready",
          enabled: capability.enabled,
          reason: capability.reason,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : "Voice is temporarily unavailable.";
        setVoiceCapabilityState({
          status: "error",
          enabled: false,
          reason: message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [localVoiceReady, userId, vaultOwnerToken, voiceEligibleRoute]);

  const voiceCapabilityReady = voiceCapabilityState.status === "ready";
  const voiceCapabilityEnabled = !localVoiceReady ? false : voiceCapabilityState.enabled;
  const voiceAvailable = localVoiceReady && voiceCapabilityReady && voiceCapabilityEnabled;
  const voiceVisibilityMode: "enabled" | "disabled" | "hidden" = voiceAvailable
    ? "enabled"
    : voiceEligibleRoute
      ? "disabled"
      : "hidden";
  const voiceUnavailableReason = voiceAvailable
    ? undefined
    : !signedIn
      ? "Sign in to use voice"
      : !isVaultUnlocked || !tokenAvailable || !tokenValid
        ? "Unlock your vault to use voice"
        : voiceCapabilityState.status === "loading"
          ? "Checking voice availability..."
          : voiceCapabilityState.reason || "Voice is not enabled for this account yet.";

  const activeAnalysisTask = useMemo(() => {
    if (!userId) return null;
    return DebateRunManagerService.getActiveTaskForUser(userId);
  }, [userId]);

  const runningImportTask = useMemo(() => {
    if (!userId) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === userId &&
          task.kind === "portfolio_import_stream" &&
          task.status === "running" &&
          !task.dismissedAt
      ) || null
    );
  }, [backgroundTaskState.tasks, userId]);

  const appRuntimeState = useMemo<AppRuntimeState>(
    () => ({
      auth: {
        signed_in: signedIn,
        user_id: userId || null,
      },
      vault: {
        unlocked: isVaultUnlocked,
        token_available: tokenAvailable,
        token_valid: tokenValid,
      },
      route: {
        pathname: pathnameWithQuery,
        screen: routeInfo.screen,
        subview: routeInfo.subview ?? null,
      },
      runtime: {
        analysis_active:
          Boolean(busyOperations["stock_analysis_active"]) ||
          Boolean(activeAnalysisTask && activeAnalysisTask.status === "running"),
        analysis_ticker: activeAnalysisTask?.ticker || analysisParams?.ticker || null,
        analysis_run_id: activeAnalysisTask?.runId || null,
        import_active:
          Boolean(busyOperations["portfolio_import_stream"]) || Boolean(runningImportTask),
        import_run_id: runningImportTask?.taskId || null,
        busy_operations: Object.keys(busyOperations).filter((name) => busyOperations[name] === true),
      },
      portfolio: {
        has_portfolio_data: hasPortfolioData,
      },
      voice: {
        available: voiceAvailable,
        tts_playing: ttsPlaying,
        last_tool_name: lastToolName,
        last_ticker: lastTicker,
      },
    }),
    [
      activeAnalysisTask,
      analysisParams?.ticker,
      busyOperations,
      hasPortfolioData,
      isVaultUnlocked,
      lastTicker,
      lastToolName,
      pathnameWithQuery,
      routeInfo.screen,
      routeInfo.subview,
      runningImportTask,
      signedIn,
      tokenAvailable,
      tokenValid,
      ttsPlaying,
      userId,
      voiceAvailable,
    ]
  );

  const voiceContext = useMemo(
    () => ({
      route: pathname,
      route_query: routeQuery || null,
      stock_analysis_active: appRuntimeState.runtime.analysis_active,
      last_tool_name: lastToolName,
      last_ticker: lastTicker,
      current_ticker: appRuntimeState.runtime.analysis_ticker || null,
      has_portfolio_data: hasPortfolioData,
    }),
    [
      appRuntimeState.runtime.analysis_active,
      appRuntimeState.runtime.analysis_ticker,
      hasPortfolioData,
      lastTicker,
      lastToolName,
      pathname,
      routeQuery,
    ]
  );

  const runKaiCommand = (command: KaiCommandAction, params?: Record<string, unknown>) => {
    const result = executeKaiCommand({
      command,
      params,
      router,
      userId,
      hasPortfolioData,
      reviewDirty,
      busyOperations,
      setAnalysisParams,
    });
    console.info(
      `[VOICE_UI] execute_kai_command command=${command} status=${result.status}${result.reason ? ` reason=${result.reason}` : ""}`
    );
    return result;
  };

  if (loading || !user || reviewScreenActive) {
    return null;
  }

  if (chromeState.hideCommandBar) {
    return null;
  }

  return (
    <KaiSearchBar
      onCommand={(command, params) => {
        runKaiCommand(command, params);
      }}
      onVoiceResponse={async (payload: {
        turnId: string;
        responseId: string;
        transcript: string;
        response: VoiceResponse;
        groundedPlan?: GroundedVoicePlan;
        memory?: VoiceMemoryHint;
        executionAllowed?: boolean;
        needsConfirmation?: boolean;
      }) => {
        const outcome = await executeVoiceResponse({
          response: payload.response,
          groundedPlan: payload.groundedPlan,
          executionAllowed: payload.executionAllowed,
          needsConfirmation: payload.needsConfirmation,
          suppressNotifications: true,
          turnId: payload.turnId,
          responseId: payload.responseId,
          userId,
          vaultOwnerToken: vaultOwnerToken || undefined,
          vaultKey: vaultKey || undefined,
          router,
          handleBack,
          executeKaiCommand: (toolCall) =>
            runKaiCommand(
              toolCall.args.command,
              toolCall.args.params
            ),
          setAnalysisParams,
          emitTelemetry: (event, telemetryPayload) => {
            appendVoiceDebugEvent({
              turnId: payload.turnId || "no_turn",
              sessionId: null,
              stage: "dispatch",
              event,
              payload: telemetryPayload,
            });
          },
          setPendingConfirmation,
        });

        if (outcome.shortTermMemoryWrite) {
          setLastVoiceTurn({
            transcript: payload.transcript,
            toolName: outcome.toolName,
            ticker: outcome.ticker,
            responseKind: outcome.responseKind,
            turnId: payload.turnId,
          });
        }

        return outcome;
      }}
      hasPortfolioData={hasPortfolioData}
      userId={userId}
      vaultOwnerToken={vaultOwnerToken || undefined}
      voiceAvailable={voiceAvailable}
      voiceVisibilityMode={voiceVisibilityMode}
      voiceUnavailableReason={voiceUnavailableReason}
      onTtsPlayingChange={setTtsPlaying}
      appRuntimeState={appRuntimeState}
      voiceContext={voiceContext}
      portfolioTickers={portfolioTickers}
    />
  );
}
