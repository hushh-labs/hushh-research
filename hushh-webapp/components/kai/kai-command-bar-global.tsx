"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { KaiSearchBar } from "@/components/kai/kai-search-bar";
import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { useVault } from "@/lib/vault/vault-context";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { startAppGoal } from "@/lib/agent/app-goal-client";

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
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agentPopover = useOptionalAgentPopover();
  const createHandoff = useOneConversationSession((state) => state.createHandoff);
  const canonicalAgentRuntime = useAgentRuntimeStateOptional();
  const { user, loading } = useAuth();
  const {
    activePersona,
    primaryNavPersona,
    personaState,
    personaTransitionTarget,
    riaSetupAvailable,
    riaSwitchAvailable,
    switchPersona,
  } = usePersonaState();
  const { isVaultUnlocked, vaultOwnerToken, tokenExpiresAt } = useVault();
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const busyOperations = useKaiSession((s) => s.busyOperations);
  const analysisParams = useKaiSession((s) => s.analysisParams);
  const cache = useMemo(() => CacheService.getInstance(), []);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState()
  );
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const userId = user?.uid ?? "";

  useEffect(() => {
    setMounted(true);
  }, []);

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
  const portfolioImportSurfaceActive = Boolean(
    busyOperations["portfolio_import_surface"]
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
  const routeQuery = searchParams?.toString() || "";
  const pathnameWithQuery = routeQuery ? `${pathname || ""}?${routeQuery}` : pathname || "";
  const routeInfo = useMemo(
    () => deriveVoiceRouteScreen(pathname || "", routeQuery),
    [pathname, routeQuery]
  );
  const agentWindowOpen =
    agentPopover?.expanded || agentPopover?.motionState === "opening";

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
      persona: {
        active: activePersona,
        primary_nav: primaryNavPersona,
        available: Array.isArray(personaState?.personas) && personaState.personas.length > 0
          ? [...personaState.personas]
          : [activePersona],
        transition_target: personaTransitionTarget || null,
        ria_switch_available: riaSwitchAvailable,
        ria_setup_available: riaSetupAvailable,
      },
      voice: {
        available: false,
        tts_playing: false,
        last_tool_name: null,
        last_ticker: null,
      },
    }),
    [
      activeAnalysisTask,
      analysisParams?.ticker,
      busyOperations,
      hasPortfolioData,
      isVaultUnlocked,
      pathnameWithQuery,
      routeInfo.screen,
      routeInfo.subview,
      runningImportTask,
      activePersona,
      signedIn,
      tokenAvailable,
      tokenValid,
      userId,
      personaState?.personas,
      personaTransitionTarget,
      primaryNavPersona,
      riaSetupAvailable,
      riaSwitchAvailable,
    ]
  );

  const appRuntimeStateRef = useRef(appRuntimeState);
  const canonicalAgentRuntimeRef = useRef(canonicalAgentRuntime);

  useEffect(() => {
    appRuntimeStateRef.current = appRuntimeState;
  }, [appRuntimeState]);

  useEffect(() => {
    canonicalAgentRuntimeRef.current = canonicalAgentRuntime;
  }, [canonicalAgentRuntime]);

  const runGatewayAction = useCallback(
    async (actionId: string, slots?: Record<string, unknown>) => {
      const runtime = canonicalAgentRuntimeRef.current;
      if (!runtime) {
        const handoff = createHandoff({
          reason: "user_requested",
          transcript: actionId,
        });
        agentPopover?.openAgent({ handoff });
        return;
      }
      await startAppGoal({
        actionId,
        slots,
        userId,
        router,
        getAppRuntimeState: () =>
          canonicalAgentRuntimeRef.current?.appRuntimeState ?? appRuntimeStateRef.current,
        getCapabilityState: () => {
          const current = canonicalAgentRuntimeRef.current;
          if (!current) {
            throw new Error("One action state is unavailable.");
          }
          return current.capabilityState;
        },
        getSurfaceMetadata: getVoiceSurfaceMetadata,
        hasPortfolioData: runtime.appRuntimeState.portfolio.has_portfolio_data,
        busyOperations,
        setAnalysisParams,
        switchPersona,
      });
    },
    [
      router,
      busyOperations,
      setAnalysisParams,
      switchPersona,
      userId,
      agentPopover,
      createHandoff,
    ]
  );

  const submitPromptToOne = useCallback(
    (prompt: string) => {
      const transcript = prompt.trim();
      if (!transcript) return;
      const handoff = createHandoff({
        reason: "user_requested",
        transcript,
      });
      agentPopover?.openAgent({ handoff });
    },
    [agentPopover, createHandoff],
  );

  if (!mounted || loading || !user || reviewScreenActive || portfolioImportSurfaceActive) {
    return null;
  }

  if (chromeState.hideCommandBar || agentWindowOpen) {
    return null;
  }

  return (
    <KaiSearchBar
      onSelectAction={(selection) => {
        void runGatewayAction(selection.actionId, selection.slots);
      }}
      onSubmitPrompt={submitPromptToOne}
      appRuntimeState={appRuntimeState}
      capabilityState={canonicalAgentRuntime?.capabilityState}
      surfaceMetadata={getVoiceSurfaceMetadata()}
      userId={userId || null}
      portfolioTickers={portfolioTickers}
    />
  );
}
