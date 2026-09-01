"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { PendingOneSystemActionInvocation } from "@/lib/capacitor/one-system-action-invocation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

type GoalAuthorization = {
  goalId: string;
  expectedScreen: string;
} | null;

type ExecuteCanonicalAction = (
  actionId: string,
  slots: Record<string, unknown>,
  goalAuthorization?: GoalAuthorization,
) => Promise<AgentActionRuntimeResult>;

/**
 * Translates a bounded Apple-system request into the exact generated gateway
 * calls One Voice already uses. Domain behavior remains in the mounted action
 * handlers; this adapter only performs authored navigation and recipient
 * selection prerequisites before invoking the canonical action id.
 */
export async function executeOneSystemActionThroughGateway(input: {
  invocation: PendingOneSystemActionInvocation;
  execute: ExecuteCanonicalAction;
  getCurrentRoute: () => { pathname: string | null; screen: string | null };
  waitForScreen: (screen: string) => Promise<boolean>;
  afterSelection: () => Promise<void>;
}): Promise<AgentActionRuntimeResult> {
  const { invocation } = input;
  const action = getKaiActionById(invocation.actionId);
  if (!action) {
    return {
      status: "invalid",
      actionId: invocation.actionId,
      label: null,
      routeBefore: null,
      resultSummary: "HUSSH does not recognize that action.",
      reason: "missing_action",
    };
  }
  if (
    action.execution_policy === "confirm_required" &&
    !invocation.confirmedBySystem
  ) {
    return {
      status: "blocked",
      actionId: invocation.actionId,
      label: action.label,
      routeBefore: input.getCurrentRoute().pathname,
      resultSummary: "Confirm this action with Siri before it can run.",
      reason: "system_confirmation_missing",
    };
  }

  const selectsRecipient =
    invocation.actionId === "location.share_selected" ||
    invocation.actionId === "location.send_request";

  if (selectsRecipient) {
    const resolvedRecipientId = invocation.slots.resolvedRecipientId;
    const person = invocation.slots.person;
    if (!resolvedRecipientId && !person) {
      return {
        status: "blocked",
        actionId: invocation.actionId,
        label: action.label,
        routeBefore: input.getCurrentRoute().pathname,
        resultSummary: "Choose a HUSSH connection first.",
        reason: "system_action_recipient_missing",
      };
    }
    const selectionActionId =
      invocation.actionId === "location.share_selected"
        ? "location.select_share_recipient"
        : "location.select_ask_recipient";
    const selectionJourney = resolveNavigationJourney(selectionActionId);
    let selectionGoalAuthorization: GoalAuthorization = null;
    if (selectionJourney) {
      // Always open the authored composer before selecting. Screen identity is
      // intentionally coarser than the Location sub-flow query, so merely
      // seeing `one_location` cannot prove that Share or Ask is active.
      const routeResult = await input.execute(
        selectionJourney.navigationActionId,
        {},
      );
      if (
        routeResult.status !== "succeeded" &&
        routeResult.status !== "started"
      ) {
        return routeResult;
      }
      if (!(await input.waitForScreen(selectionJourney.destinationScreen))) {
        return {
          status: "blocked",
          actionId: invocation.actionId,
          label: action.label,
          routeBefore: routeResult.routeBefore,
          routeAfter: routeResult.routeAfter,
          resultSummary:
            "Location is still opening. Your request is preserved.",
          reason: "system_action_destination_not_ready",
        };
      }
      selectionGoalAuthorization = {
        goalId: selectionJourney.goalId,
        expectedScreen: selectionJourney.destinationScreen,
      };
    }
    const selection = await input.execute(
      selectionActionId,
      resolvedRecipientId ? { resolvedRecipientId } : { person },
      selectionGoalAuthorization,
    );
    if (selection.status !== "succeeded") return selection;
    await input.afterSelection();
  }

  // The generated journey belongs to the requested action itself. Recipient
  // composites above instead use their selection action's narrower journey;
  // authorizing the final mutation as globally navigable could apply it to
  // stale recipients from an older composer state.
  const journey = selectsRecipient
    ? null
    : resolveNavigationJourney(invocation.actionId, action);
  let goalAuthorization: GoalAuthorization = null;
  if (journey && input.getCurrentRoute().screen !== journey.destinationScreen) {
    const routeResult = await input.execute(journey.navigationActionId, {});
    if (
      routeResult.status !== "succeeded" &&
      routeResult.status !== "started"
    ) {
      return routeResult;
    }
    if (!(await input.waitForScreen(journey.destinationScreen))) {
      return {
        status: "blocked",
        actionId: invocation.actionId,
        label: action.label,
        routeBefore: routeResult.routeBefore,
        routeAfter: routeResult.routeAfter,
        resultSummary: "Location is still opening. Your request is preserved.",
        reason: "system_action_destination_not_ready",
      };
    }
    goalAuthorization = {
      goalId: journey.goalId,
      expectedScreen: journey.destinationScreen,
    };
  }

  const slots: Record<string, unknown> = { ...invocation.slots };
  if (selectsRecipient) {
    delete slots.resolvedRecipientId;
  }
  return input.execute(invocation.actionId, slots, goalAuthorization);
}
