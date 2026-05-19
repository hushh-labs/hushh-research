import { executeKaiCommand } from "@/lib/kai/command-executor";
import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
} from "@/lib/voice/kai-action-gateway";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type RouterLike = {
  push: (href: string) => void;
};

export type AgentActionRuntimeResult = {
  status: "succeeded" | "started" | "blocked" | "invalid" | "failed" | "noop";
  actionId: string | null;
  label: string | null;
  routeBefore: string | null;
  routeAfter?: string | null;
  screenBefore?: string | null;
  screenAfter?: string | null;
  resultSummary: string;
  reason?: string | null;
  data?: Record<string, unknown>;
};

export type ExecuteAgentGatewayActionInput = {
  actionId: string;
  slots?: Record<string, unknown>;
  userId: string;
  router: RouterLike;
  appRuntimeState: AppRuntimeState;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  hasPortfolioData: boolean;
  busyOperations: Record<string, boolean>;
  setAnalysisParams: (params: AnalysisParams | null) => void;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildResult(input: Partial<AgentActionRuntimeResult>): AgentActionRuntimeResult {
  return {
    status: input.status || "failed",
    actionId: input.actionId ?? null,
    label: input.label ?? null,
    routeBefore: input.routeBefore ?? null,
    routeAfter: input.routeAfter,
    screenBefore: input.screenBefore,
    screenAfter: input.screenAfter,
    resultSummary: input.resultSummary || "Agent action failed.",
    reason: input.reason,
    data: input.data,
  };
}

export async function executeAgentGatewayAction(
  input: ExecuteAgentGatewayActionInput
): Promise<AgentActionRuntimeResult> {
  const routeBefore = input.appRuntimeState.route;
  const action = getKaiActionById(input.actionId);
  if (!action) {
    return buildResult({
      status: "invalid",
      actionId: input.actionId,
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary: "Agent could not find that Kai action.",
      reason: "missing_action",
    });
  }

  const availability = evaluateKaiActionAvailability({
    action,
    appRuntimeState: input.appRuntimeState,
    surfaceMetadata: input.surfaceMetadata,
  });
  if (availability.status !== "available") {
    return buildResult({
      status: "blocked",
      actionId: action.action_id,
      label: action.label,
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary:
        availability.blocked_guidance ||
        availability.reason ||
        "That Kai action is not available right now.",
      reason: availability.status,
    });
  }

  if (action.execution_target.status !== "wired") {
    return buildResult({
      status: "invalid",
      actionId: action.action_id,
      label: action.label,
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary: "That Kai action is not wired for execution yet.",
      reason: action.execution_target.status,
    });
  }

  if (action.execution_target.path === "route") {
    input.router.push(action.execution_target.target);
    return buildResult({
      status: "started",
      actionId: action.action_id,
      label: action.label,
      routeBefore: routeBefore.pathname,
      routeAfter: action.execution_target.target,
      screenBefore: routeBefore.screen,
      resultSummary: `${action.label} opened in Kai.`,
      data: { target: action.execution_target.target },
    });
  }

  if (action.execution_target.path !== "kai_command") {
    return buildResult({
      status: "blocked",
      actionId: action.action_id,
      label: action.label,
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary: "That action belongs to the voice runtime and is not available in Agent text yet.",
      reason: "voice_tool_not_available",
    });
  }

  const params: Record<string, unknown> = {
    ...(action.execution_target.params || {}),
  };
  const symbol = readString(input.slots?.symbol);
  if (action.execution_target.target === "analyze" && symbol) {
    params.symbol = symbol.toUpperCase();
    delete params.requires_symbol;
  }

  const commandResult = executeKaiCommand({
    command: action.execution_target.target as KaiCommandAction,
    params,
    router: input.router,
    userId: input.userId,
    hasPortfolioData: input.hasPortfolioData,
    reviewDirty: false,
    busyOperations: input.busyOperations,
    setAnalysisParams: input.setAnalysisParams,
    currentRoute: routeBefore.pathname,
    currentScreen: routeBefore.screen,
  });

  return buildResult({
    status: commandResult.actionResult.status,
    actionId: commandResult.actionResult.actionId || action.action_id,
    label: action.label,
    routeBefore: commandResult.actionResult.routeBefore,
    routeAfter: commandResult.actionResult.routeAfter,
    screenBefore: commandResult.actionResult.screenBefore,
    screenAfter: commandResult.actionResult.screenAfter,
    resultSummary: commandResult.actionResult.resultSummary,
    reason: commandResult.reason,
    data: commandResult.actionResult.data,
  });
}
