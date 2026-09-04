import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { waitForVoiceActionSettlement } from "@/lib/voice/voice-action-settlement";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

type GatewaySettlementOptions = {
  getCurrentRoute: () => AppRuntimeState["route"] | undefined;
  getCurrentSurfaceMetadata: () => VoiceSurfaceMetadata | null;
  timeoutMs?: number;
};

/** Inputs may select an action; only the generated gateway executes it. */
export async function settleAgentGatewayAction(
  result: AgentActionRuntimeResult,
  options: GatewaySettlementOptions,
): Promise<AgentActionRuntimeResult> {
  if (!result.routeAfter || (result.status !== "started" && result.status !== "succeeded")) {
    return result;
  }

  const settlement = await waitForVoiceActionSettlement({
    actionId: result.actionId,
    mode: "execute_and_wait",
    actionStatus: result.status,
    routeBefore: {
      pathname: result.routeBefore || "",
      screen: result.screenBefore || "",
      subview: null,
    },
    expectedRoute: result.routeAfter,
    expectedScreen: result.screenAfter,
    getCurrentRoute: options.getCurrentRoute,
    getCurrentSurfaceMetadata: options.getCurrentSurfaceMetadata,
    timeoutMs: options.timeoutMs,
  });

  if (settlement.settled_by === "timeout") {
    return {
      ...result,
      status: "started",
      reason: "route_settlement_timeout",
      routeAfter: settlement.route_after || result.routeAfter,
      screenAfter: settlement.screen_after || result.screenAfter,
      resultSummary: "The action started, but the next screen is still settling.",
    };
  }

  return {
    ...result,
    status: "succeeded",
    routeAfter: settlement.route_after || result.routeAfter,
    screenAfter: settlement.screen_after || result.screenAfter,
  };
}
