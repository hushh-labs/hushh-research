import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { KaiCommandAction, KaiCommandParams } from "@/lib/kai/kai-command-types";
import {
  getInvestorKaiActionByKaiCommand,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";

type RouterLike = {
  push: (href: string) => void;
};

export type VoiceActionResultStatus =
  | "succeeded"
  | "started"
  | "blocked"
  | "invalid"
  | "failed"
  | "noop";

export type VoiceActionResult = {
  status: VoiceActionResultStatus;
  actionId: string | null;
  routeBefore: string | null;
  routeAfter: string | null;
  screenBefore: string | null;
  screenAfter: string | null;
  resultSummary: string;
  data?: Record<string, unknown>;
};

type BuildVoiceActionResultInput = {
  status: VoiceActionResultStatus;
  actionId?: string | null;
  routeBefore?: string | null;
  routeAfter?: string | null;
  screenBefore?: string | null;
  screenAfter?: string | null;
  resultSummary: string;
  data?: Record<string, unknown>;
};

export function buildVoiceActionResult(
  input: BuildVoiceActionResultInput
): VoiceActionResult {
  return {
    status: input.status,
    actionId: input.actionId ?? null,
    routeBefore: input.routeBefore ?? null,
    routeAfter: input.routeAfter ?? null,
    screenBefore: input.screenBefore ?? null,
    screenAfter: input.screenAfter ?? null,
    resultSummary: input.resultSummary,
    data: input.data,
  };
}

export type ExecuteKaiCommandResult = {
  status: "executed" | "blocked" | "invalid";
  reason?: string;
  actionResult: VoiceActionResult;
};

export type ExecuteKaiCommandInput = {
  command: KaiCommandAction;
  params?: Record<string, unknown> | KaiCommandParams;
  router: RouterLike;
  userId: string;
  hasPortfolioData: boolean;
  reviewDirty: boolean;
  busyOperations: Record<string, boolean>;
  setAnalysisParams: (params: AnalysisParams | null) => void;
  confirm?: (message: string) => boolean;
  currentRoute?: string | null;
  currentScreen?: string | null;
};

const VALID_HISTORY_TABS = new Set(["history", "debate", "summary", "transcript"]);

function getHistoryTarget(params?: Record<string, unknown> | KaiCommandParams): string {
  if (!params || typeof params !== "object") {
    return `${ROUTES.KAI_ANALYSIS}?tab=history`;
  }

  const tabRaw = typeof params.tab === "string" ? params.tab : null;
  const focusRaw = typeof params.focus === "string" ? params.focus : null;

  const query = new URLSearchParams();
  if (tabRaw && VALID_HISTORY_TABS.has(tabRaw)) {
    query.set("tab", tabRaw);
  }
  if (focusRaw === "active") {
    query.set("focus", "active");
  }
  if (!query.has("tab") && !query.has("focus")) {
    query.set("tab", "history");
  }

  const suffix = query.toString();
  return suffix ? `${ROUTES.KAI_ANALYSIS}?${suffix}` : ROUTES.KAI_ANALYSIS;
}

function getActiveAnalysisTarget(symbol?: string | null): string {
  const query = new URLSearchParams();
  query.set("focus", "active");
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  if (normalizedSymbol) {
    query.set("ticker", normalizedSymbol);
  }
  return `${ROUTES.KAI_ANALYSIS}?${query.toString()}`;
}

type BuildCommandResultInput = {
  status: ExecuteKaiCommandResult["status"];
  actionStatus?: VoiceActionResultStatus;
  reason?: string;
  actionId: string | null;
  routeBefore?: string | null;
  routeAfter?: string | null;
  screenBefore?: string | null;
  screenAfter?: string | null;
  resultSummary: string;
  data?: Record<string, unknown>;
};

function buildCommandResult(input: BuildCommandResultInput): ExecuteKaiCommandResult {
  const actionStatus: VoiceActionResultStatus =
    input.actionStatus ??
    (input.status === "executed"
      ? "succeeded"
      : input.status === "blocked"
        ? "blocked"
        : "invalid");

  return {
    status: input.status,
    reason: input.reason,
    actionResult: buildVoiceActionResult({
      status: actionStatus,
      actionId: input.actionId,
      routeBefore: input.routeBefore,
      routeAfter: input.routeAfter,
      screenBefore: input.screenBefore,
      screenAfter: input.screenAfter,
      resultSummary: input.resultSummary,
      data: input.data,
    }),
  };
}

export function executeKaiCommand(input: ExecuteKaiCommandInput): ExecuteKaiCommandResult {
  const {
    command,
    params,
    router,
    userId,
    hasPortfolioData,
    reviewDirty,
    busyOperations,
    setAnalysisParams,
    confirm,
    currentRoute,
    currentScreen,
  } = input;

  const confirmLeave =
    confirm ||
    ((message: string) => {
      if (typeof window === "undefined") return true;
      return window.confirm(message);
    });

  if (
    reviewDirty &&
    !confirmLeave("You have unsaved portfolio changes. Leaving now will discard them.")
  ) {
    return buildCommandResult({
      status: "blocked",
      reason: "review_dirty",
      actionId: null,
      routeBefore: currentRoute,
      screenBefore: currentScreen,
      resultSummary: "Stayed on the current screen because portfolio review has unsaved changes.",
      data: { command },
    });
  }

  const canonicalAction = getInvestorKaiActionByKaiCommand(command);
  const actionId = canonicalAction?.id ?? null;
  if (canonicalAction) {
    const resolution = resolveInvestorKaiActionWiring(canonicalAction);
    if (!resolution.resolvable) {
      console.warn(
        `[KAI_ACTION_REGISTRY] unresolved_wired_action id=${canonicalAction.id} reason=${resolution.reason}`
      );
    } else {
      console.info(`[KAI_ACTION_REGISTRY] resolved_action id=${canonicalAction.id}`);
    }
  } else {
    console.warn(`[KAI_ACTION_REGISTRY] missing_action_for_command command=${command}`);
  }

  if (!hasPortfolioData && command === "optimize") {
    toast.info("Import your portfolio to unlock this command.");
    router.push(ROUTES.KAI_IMPORT);
    return buildCommandResult({
      status: "blocked",
      reason: "portfolio_required",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.KAI_IMPORT,
      screenBefore: currentScreen,
      screenAfter: "import",
      resultSummary: "Portfolio import is required before that Kai command can run.",
      data: { command },
    });
  }

  if (command === "analyze") {
    const symbolRaw =
      params && typeof params === "object" && typeof params.symbol === "string"
        ? params.symbol
        : "";
    const symbol = String(symbolRaw || "").trim().toUpperCase();

    if (!symbol) {
      return buildCommandResult({
        status: "invalid",
        reason: "missing_symbol",
        actionId,
        routeBefore: currentRoute,
        screenBefore: currentScreen,
        resultSummary: "Analysis could not start because no stock symbol was provided.",
        data: { command },
      });
    }

    if (busyOperations["stock_analysis_active"]) {
      toast.error("A debate is already running.", {
        description: "Open analysis to continue with the active run.",
      });
      router.push(getActiveAnalysisTarget(symbol));
      return buildCommandResult({
        status: "blocked",
        reason: "stock_analysis_active",
        actionId,
        routeBefore: currentRoute,
        routeAfter: getActiveAnalysisTarget(symbol),
        screenBefore: currentScreen,
        screenAfter: "kai_analysis",
        resultSummary: `Analysis for ${symbol} was not started because another run is already active.`,
        data: { command, symbol },
      });
    }

    setAnalysisParams({
      ticker: symbol,
      userId,
      riskProfile: "balanced",
    });
    const routeAfter = getActiveAnalysisTarget(symbol);
    router.push(routeAfter);
    return buildCommandResult({
      status: "executed",
      actionStatus: "started",
      actionId,
      routeBefore: currentRoute,
      routeAfter,
      screenBefore: currentScreen,
      screenAfter: "kai_analysis",
      resultSummary: `Started analysis for ${symbol} in the Kai analysis workspace.`,
      data: { command, symbol },
    });
  }

  if (command === "optimize") {
    router.push(ROUTES.KAI_OPTIMIZE);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.KAI_OPTIMIZE,
      screenBefore: currentScreen,
      screenAfter: "optimize",
      resultSummary: "Opened the Kai optimization workspace.",
      data: { command },
    });
  }

  if (command === "import") {
    router.push(ROUTES.KAI_IMPORT);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.KAI_IMPORT,
      screenBefore: currentScreen,
      screenAfter: "import",
      resultSummary: "Opened the Kai portfolio import flow.",
      data: { command },
    });
  }

  if (command === "history") {
    const routeAfter = getHistoryTarget(params);
    router.push(routeAfter);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter,
      screenBefore: currentScreen,
      screenAfter: "kai_analysis",
      resultSummary: "Opened the Kai analysis history view.",
      data: { command },
    });
  }

  if (command === "dashboard") {
    router.push(ROUTES.KAI_DASHBOARD);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.KAI_DASHBOARD,
      screenBefore: currentScreen,
      screenAfter: "dashboard",
      resultSummary: "Opened the Kai dashboard.",
      data: { command },
    });
  }

  if (command === "home") {
    router.push(ROUTES.KAI_HOME);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.KAI_HOME,
      screenBefore: currentScreen,
      screenAfter: "home",
      resultSummary: "Opened the Kai home screen.",
      data: { command },
    });
  }

  if (command === "consent") {
    router.push(ROUTES.CONSENTS);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.CONSENTS,
      screenBefore: currentScreen,
      screenAfter: "consents",
      resultSummary: "Opened the consent center.",
      data: { command },
    });
  }

  if (command === "profile") {
    router.push(ROUTES.PROFILE);
    return buildCommandResult({
      status: "executed",
      actionId,
      routeBefore: currentRoute,
      routeAfter: ROUTES.PROFILE,
      screenBefore: currentScreen,
      screenAfter: "profile",
      resultSummary: "Opened your profile.",
      data: { command },
    });
  }

  return buildCommandResult({
    status: "invalid",
    reason: "unknown_command",
    actionId,
    routeBefore: currentRoute,
    screenBefore: currentScreen,
    resultSummary: "That Kai command is not supported.",
    data: { command },
  });
}
