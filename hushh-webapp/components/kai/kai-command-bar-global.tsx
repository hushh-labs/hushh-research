"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import {
  KaiCommandPalette,
  type KaiPortfolioTicker,
} from "@/components/kai/kai-command-palette";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import {
  KAI_COMMAND_BAR_OPEN_EVENT,
  KAI_COMMAND_BAR_TOGGLE_EVENT,
  type KaiCommandBarOpenRequest,
} from "@/lib/navigation/kai-command-bar-events";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { startAppGoal } from "@/lib/agent/app-goal-client";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";

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

/** The holdings search can offer to analyze, from the cached portfolio. */
function readPortfolioTickers(userId: string): KaiPortfolioTicker[] {
  const cache = CacheService.getInstance();
  const cachedPortfolio =
    cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
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

  const tickers = new Map<string, KaiPortfolioTicker>();
  for (const holding of holdings) {
    const symbol = String(holding.symbol || "").trim().toUpperCase();
    if (!symbol || tickers.has(symbol)) continue;
    if (!computeAnalyzeEligibilityFromHolding(holding)) continue;
    tickers.set(symbol, {
      symbol,
      name: holding.name ? String(holding.name) : undefined,
      sector: holding.sector ? String(holding.sector) : undefined,
      asset_type: holding.asset_type ? String(holding.asset_type) : undefined,
    });
  }
  return Array.from(tickers.values());
}

/**
 * Hosts the "Search or ask One" palette as global chrome.
 *
 * One Agent Bar is the only microphone and natural-language voice surface.
 * This owns only keyboard/search discovery and forwards a free-form prompt to
 * the same Agent Chat handoff.
 *
 * App state comes from AgentRuntimeStateProvider -- the same snapshot the
 * action runtime executes against -- so what search offers and what running
 * it does cannot disagree.
 */
export function KaiCommandBarGlobal() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<KaiCommandBarOpenRequest>({});
  const router = useRouter();
  const pathname = usePathname();
  const createHandoff = useOneConversationSession((state) => state.createHandoff);
  const agentRuntime = useAgentRuntimeStateOptional();
  const { user, loading } = useAuth();
  const { switchPersona } = usePersonaState();
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const busyOperations = useKaiSession((s) => s.busyOperations);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const userId = user?.uid ?? "";

  useEffect(() => {
    setMounted(true);
  }, []);

  const reviewScreenActive = Boolean(
    busyOperations["portfolio_review_active"] || busyOperations["portfolio_save"]
  );
  const portfolioImportSurfaceActive = Boolean(
    busyOperations["portfolio_import_surface"]
  );
  const available =
    mounted &&
    !loading &&
    Boolean(user) &&
    !reviewScreenActive &&
    !portfolioImportSurfaceActive &&
    !chromeState.hideCommandBar;

  // Open requests only count while search is available. One made while it is
  // hidden must not pop the palette open on the next screen that shows it.
  useEffect(() => {
    if (!available) {
      setOpen(false);
      setOpenRequest({});
      return;
    }
    const openPalette = (event: Event) => {
      const request = (event as CustomEvent<KaiCommandBarOpenRequest>).detail;
      setOpenRequest(request && typeof request === "object" ? request : {});
      setOpen(true);
    };
    const togglePalette = () => setOpen((current) => !current);
    window.addEventListener(KAI_COMMAND_BAR_OPEN_EVENT, openPalette);
    window.addEventListener(KAI_COMMAND_BAR_TOGGLE_EVENT, togglePalette);
    return () => {
      window.removeEventListener(KAI_COMMAND_BAR_OPEN_EVENT, openPalette);
      window.removeEventListener(KAI_COMMAND_BAR_TOGGLE_EVENT, togglePalette);
    };
  }, [available]);

  // Read on open, so a portfolio imported after sign-in is searchable.
  const portfolioTickers = useMemo(
    () => (open && userId ? readPortfolioTickers(userId) : []),
    [open, userId]
  );

  const agentRuntimeRef = useRef(agentRuntime);
  useEffect(() => {
    agentRuntimeRef.current = agentRuntime;
  }, [agentRuntime]);

  const runGatewayAction = useCallback(
    async (actionId: string, slots?: Record<string, unknown>) => {
      const runtime = agentRuntimeRef.current;
      if (!runtime) {
        createHandoff({
          reason: "user_requested",
          transcript: actionId,
        });
        navigateToAgentChat();
        return;
      }
      await startAppGoal({
        actionId,
        slots,
        userId,
        router,
        getAppRuntimeState: () =>
          agentRuntimeRef.current?.appRuntimeState ?? runtime.appRuntimeState,
        getCapabilityState: () => {
          const current = agentRuntimeRef.current;
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
      createHandoff,
    ]
  );

  const submitPromptToOne = useCallback(
    (prompt: string) => {
      const transcript = prompt.trim();
      if (!transcript) return;
      createHandoff({
        reason: "user_requested",
        transcript,
      });
      navigateToAgentChat();
    },
    [createHandoff],
  );

  if (!available) {
    return null;
  }

  return (
    <KaiCommandPalette
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setOpenRequest({});
      }}
      intent={openRequest.intent}
      initialQuery={openRequest.initialQuery}
      onSelectAction={(selection) => {
        void runGatewayAction(selection.actionId, selection.slots);
      }}
      onSubmitPrompt={submitPromptToOne}
      appRuntimeState={agentRuntime?.appRuntimeState}
      capabilityState={agentRuntime?.capabilityState}
      surfaceMetadata={getVoiceSurfaceMetadata()}
      userId={userId || null}
      portfolioTickers={portfolioTickers}
    />
  );
}
