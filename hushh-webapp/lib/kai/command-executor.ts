import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildKaiAnalysisPreviewRoute, ROUTES } from "@/lib/navigation/routes";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { KaiCommandAction, KaiCommandParams } from "@/lib/kai/kai-command-types";
import {
  getInvestorKaiActionByKaiCommand,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";

type RouterLike = {
  push: (href: string) => void;
};

export type ExecuteKaiCommandResult = {
  status: "executed" | "blocked" | "invalid";
  reason?: string;
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
};

const VALID_HISTORY_TABS = new Set(["history", "debate", "summary", "transcript"]);

function getHistoryTarget(params?: Record<string, unknown> | KaiCommandParams): string {
  if (!params || typeof params !== "object") {
    return ROUTES.KAI_ANALYSIS;
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

  const suffix = query.toString();
  return suffix ? `${ROUTES.KAI_ANALYSIS}?${suffix}` : ROUTES.KAI_ANALYSIS;
}

export function executeKaiCommand(input: ExecuteKaiCommandInput): ExecuteKaiCommandResult {
  const {
    command,
    params,
    router,
    hasPortfolioData,
    reviewDirty,
    busyOperations,
    setAnalysisParams,
    confirm,
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
    return { status: "blocked", reason: "review_dirty" };
  }

  const canonicalAction = getInvestorKaiActionByKaiCommand(command);
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

  if (!hasPortfolioData && (command === "analyze" || command === "history" || command === "optimize")) {
    toast.info("Import your portfolio to unlock this command.");
    router.push(ROUTES.KAI_IMPORT);
    return { status: "blocked", reason: "portfolio_required" };
  }

  if (command === "analyze") {
    const symbolRaw =
      params && typeof params === "object" && typeof params.symbol === "string"
        ? params.symbol
        : "";
    const symbol = String(symbolRaw || "").trim().toUpperCase();

    if (!symbol) {
      return { status: "invalid", reason: "missing_symbol" };
    }

    if (busyOperations["stock_analysis_active"]) {
      toast.error("A debate is already running.", {
        description: "Open analysis to continue with the active run.",
      });
      router.push(ROUTES.KAI_ANALYSIS);
      return { status: "blocked", reason: "stock_analysis_active" };
    }

    setAnalysisParams(null);
    router.push(
      buildKaiAnalysisPreviewRoute({
        ticker: symbol,
      })
    );
    return { status: "executed" };
  }

  if (command === "optimize") {
    router.push(ROUTES.KAI_OPTIMIZE);
    return { status: "executed" };
  }

  if (command === "import") {
    router.push(ROUTES.KAI_IMPORT);
    return { status: "executed" };
  }

  if (command === "history") {
    router.push(getHistoryTarget(params));
    return { status: "executed" };
  }

  if (command === "dashboard") {
    router.push(ROUTES.KAI_DASHBOARD);
    return { status: "executed" };
  }

  if (command === "home") {
    router.push(ROUTES.KAI_HOME);
    return { status: "executed" };
  }

  if (command === "consent") {
    router.push(ROUTES.CONSENTS);
    return { status: "executed" };
  }

  if (command === "profile") {
    router.push(ROUTES.PROFILE);
    return { status: "executed" };
  }

  return { status: "invalid", reason: "unknown_command" };
}
