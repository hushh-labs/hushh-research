import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { waitForVoiceActionSettlement } from "@/lib/voice/voice-action-settlement";
import {
  getVoiceSurfaceMetadata,
  type VoiceSurfaceMetadata,
} from "@/lib/kai/actions/voice-surface-metadata";
import { deriveVoiceRouteScreen } from "@/lib/kai/actions/route-screen-derivation";
import type { AppRuntimeState } from "@/lib/kai/actions/voice-types";
import { settleProductDispatch } from "@/lib/observability/product-activity-client";

type GatewaySettlementOptions = {
  getCurrentRoute: () => AppRuntimeState["route"] | undefined;
  getCurrentSurfaceMetadata: () => VoiceSurfaceMetadata | null;
  timeoutMs?: number;
};

/** Chat navigation may unmount the chat workspace before the destination publishes. */
export async function settleChatLocationNavigation(result: AgentActionRuntimeResult) {
  if (
    typeof window === "undefined" ||
    (result.actionId !== "route.one_location" && result.actionId !== "location.open_settings")
  ) {
    return result;
  }
  return settleAgentGatewayAction(result, {
    getCurrentRoute: () => {
      const pathname = window.location.pathname + window.location.search;
      const { screen, subview } = deriveVoiceRouteScreen(pathname);
      return { pathname, screen, subview: subview ?? null };
    },
    getCurrentSurfaceMetadata: getVoiceSurfaceMetadata,
  });
}

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

  return settleProductDispatch<AgentActionRuntimeResult>(result, {
    ...result,
    status: "succeeded",
    routeAfter: settlement.route_after || result.routeAfter,
    screenAfter: settlement.screen_after || result.screenAfter,
  });
}
