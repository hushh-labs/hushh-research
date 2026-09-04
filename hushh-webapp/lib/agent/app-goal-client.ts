import {
  executeAgentGatewayAction,
  type AgentActionRuntimeResult,
  type ExecuteAgentGatewayActionInput,
} from "@/lib/agent/agent-action-runtime";
import { settleAgentGatewayAction } from "@/lib/agent/agent-gateway-action-settlement";
import {
  projectKaiActionCapability,
  type VoiceCapabilityStateV1,
} from "@/lib/voice/capability-projection";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import {
  firstMissingRequiredSlot,
  resolveJourneySlots,
  resolveNavigationJourney,
} from "@/lib/voice/navigation-journey";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export type GoalRunV1 = {
  schema_version: "one.goal_run.v1";
  goal_id: string;
  action_id: string;
  slots: Record<string, unknown>;
  step_cursor: number;
  expected_screen: string;
  expected_route_revision: string;
  status: "running" | "awaiting_settlement" | "completed" | "blocked";
};

type StartAppGoalInput = Omit<ExecuteAgentGatewayActionInput, "actionId" | "slots" | "appRuntimeState" | "surfaceMetadata" | "allowedActionIds" | "goalAuthorization"> & {
  actionId: string;
  slots?: Record<string, unknown>;
  getAppRuntimeState: () => ExecuteAgentGatewayActionInput["appRuntimeState"];
  getCapabilityState: () => VoiceCapabilityStateV1;
  getSurfaceMetadata: () => VoiceSurfaceMetadata | null;
  onGoalRun?: (goal: GoalRunV1) => void;
};

function blocked(actionId: string, summary: string): AgentActionRuntimeResult {
  return {
    status: "blocked",
    actionId,
    label: null,
    routeBefore: null,
    resultSummary: summary,
    reason: "goal_projection_blocked",
  };
}

async function waitForScreen(
  getAppRuntimeState: StartAppGoalInput["getAppRuntimeState"],
  expectedScreen: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getAppRuntimeState().route.screen === expectedScreen) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Runs explicit generated command selections. Free-form language is not sent
 * here: Agent Chat and Live send it to One/ADK for semantic selection.
 */
export async function startAppGoal(
  input: StartAppGoalInput,
): Promise<AgentActionRuntimeResult> {
  const slots = input.slots || {};
  const initialState = input.getCapabilityState();
  const initialProjection = projectKaiActionCapability({
    actionId: input.actionId,
    state: initialState,
    surfaceMetadata: input.getSurfaceMetadata(),
  });
  if (
    initialProjection.status === "blocked" ||
    initialProjection.status === "terminal" ||
    initialProjection.status === "manual_only" ||
    initialProjection.status === "unwired" ||
    initialProjection.status === "dead"
  ) {
    return blocked(input.actionId, initialProjection.reason || "That action is unavailable.");
  }

  // Which actions can cross a screen boundary is declared by the generated
  // contract, not named here. This used to read `!== "analysis.start"`, so
  // the browser could only ever walk one journey however many were authored.
  const journeyAction = getKaiActionById(input.actionId);
  const journey = journeyAction
    ? resolveNavigationJourney(input.actionId, journeyAction)
    : null;

  if (!journey || !journeyAction) {
    const result = await executeAgentGatewayAction({
      ...input,
      actionId: input.actionId,
      slots,
      appRuntimeState: input.getAppRuntimeState(),
      surfaceMetadata: input.getSurfaceMetadata(),
      allowedActionIds: initialState.available_action_ids,
    });
    return settleAgentGatewayAction(result, {
      getCurrentRoute: () => input.getAppRuntimeState().route,
      getCurrentSurfaceMetadata: input.getSurfaceMetadata,
    });
  }

  const missing = firstMissingRequiredSlot(journeyAction, slots);
  if (missing) {
    return blocked(input.actionId, missing.prompt);
  }

  const goal: GoalRunV1 = {
    schema_version: "one.goal_run.v1",
    goal_id: journey.goalId,
    action_id: input.actionId,
    slots: resolveJourneySlots(journeyAction, slots),
    step_cursor: 0,
    expected_screen: journey.destinationScreen,
    expected_route_revision: initialState.route_revision,
    status: "running",
  };
  input.onGoalRun?.(goal);

  if (input.getAppRuntimeState().route.screen !== journey.destinationScreen) {
    const routeResult = await executeAgentGatewayAction({
      ...input,
      actionId: journey.navigationActionId,
      slots: {},
      appRuntimeState: input.getAppRuntimeState(),
      surfaceMetadata: input.getSurfaceMetadata(),
      allowedActionIds: initialState.available_action_ids,
    });
    const settledRoute = await settleAgentGatewayAction(routeResult, {
      getCurrentRoute: () => input.getAppRuntimeState().route,
      getCurrentSurfaceMetadata: input.getSurfaceMetadata,
    });
    if (settledRoute.status === "blocked" || settledRoute.status === "failed") {
      return settledRoute;
    }
    goal.step_cursor = 1;
    goal.status = "awaiting_settlement";
    input.onGoalRun?.(goal);
    if (
      !(await waitForScreen(input.getAppRuntimeState, journey.destinationScreen))
    ) {
      return blocked(
        input.actionId,
        `${journeyAction.label} is still opening. Try again once it is ready.`,
      );
    }
  }

  const settledState = input.getCapabilityState();
  const settledProjection = projectKaiActionCapability({
    actionId: input.actionId,
    state: settledState,
    surfaceMetadata: input.getSurfaceMetadata(),
  });
  if (settledProjection.status === "blocked" || settledProjection.status === "terminal") {
    return blocked(
      input.actionId,
      settledProjection.reason || `${journeyAction.label} is unavailable.`,
    );
  }

  const previewResult = await executeAgentGatewayAction({
    ...input,
    actionId: input.actionId,
    slots: goal.slots,
    appRuntimeState: input.getAppRuntimeState(),
    surfaceMetadata: input.getSurfaceMetadata(),
    allowedActionIds: settledState.available_action_ids,
    goalAuthorization: {
      goalId: journey.goalId,
      expectedScreen: journey.destinationScreen,
    },
  });
  const settledPreview = await settleAgentGatewayAction(previewResult, {
    getCurrentRoute: () => input.getAppRuntimeState().route,
    getCurrentSurfaceMetadata: input.getSurfaceMetadata,
  });
  goal.step_cursor = 2;
  goal.status = settledPreview.status === "blocked" ? "blocked" : "completed";
  input.onGoalRun?.(goal);
  return settledPreview;
}
