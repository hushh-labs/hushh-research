import { executeKaiCommand } from "@/lib/kai/command-executor";
import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import {
  resolveLocalOnboardingHandler,
  waitForLocalOnboardingHandler,
  type LocalOnboardingActionContext,
  type LocalOnboardingActionResult,
} from "@/lib/agent/local-onboarding-actions";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import {
  parseVoiceCard,
  publishVoiceCard,
} from "@/lib/voice/voice-action-card";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { Persona } from "@/lib/services/ria-service";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
} from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";
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
  /** Exact redacted snapshot inventory. An empty array fails closed. */
  allowedActionIds?: readonly string[] | null;
  hasPortfolioData: boolean;
  busyOperations: Record<string, boolean>;
  setAnalysisParams: (params: AnalysisParams | null) => void;
  switchPersona?: (target: Persona) => Promise<unknown>;
  executionContext?: LocalOnboardingActionContext;
  signal?: AbortSignal;
  /**
   * Narrow authorization issued by the generated goal runner. It never makes
   * an arbitrary off-screen control executable; it only permits the Analysis
   * preview step after the generated route step has settled on Analysis.
   */
  goalAuthorization?: {
    goalId: string;
    expectedScreen: string;
  } | null;
};

function hasPublishedActionInventory(
  surfaceMetadata: VoiceSurfaceMetadata | null | undefined,
): string[] {
  const actionIds = [
    ...(surfaceMetadata?.actions || []).map((action) =>
      String(action.actionId || action.id || "").trim(),
    ),
    ...(surfaceMetadata?.controls || []).map((control) =>
      String(control.actionId || "").trim(),
    ),
  ].filter(Boolean);
  return Array.from(new Set(actionIds));
}

function isActionInActiveInventory(
  input: ExecuteAgentGatewayActionInput,
): boolean {
  const activeLayer = input.surfaceMetadata?.interactionLayer;
  const routeIsBlockedByActiveLayer = Boolean(
    activeLayer &&
      activeLayer.lifecycle !== "closing" &&
      (activeLayer.blocksUnderlyingActions ||
        activeLayer.modality === "modal" ||
        activeLayer.modality === "blocking" ||
        activeLayer.agentContinuity !== "interactive"),
  );

  // Navigation is reachable from any screen. Deciding WHICH actions count as
  // navigation has to match `is_navigation_action` in action_gateway.py
  // exactly, because the relay offers an action on that basis and the browser
  // refuses it on this one -- so any gap between the two predicates is an
  // action One proposes and the app then rejects.
  //
  // The union is load-bearing in BOTH directions, and this file has now had it
  // wrong each way round:
  //
  //   - Testing only the NAME missed `location.open_share` and
  //     `setup.open_finance`, which navigate but are surface-named. That
  //     blocked a journey's own first step: One escorted someone to Location
  //     and the browser refused to go.
  //   - Testing only the PATH then missed the five wired `route.*` actions
  //     whose path is `kai_command` or `voice_tool` -- route.profile,
  //     route.consents, route.back, route.analysis_history, route.kai_import.
  //     Those had worked for months on the name test alone.
  if (!routeIsBlockedByActiveLayer) {
    const action = getKaiActionById(input.actionId);
    if (
      action &&
      action.execution_policy === "allow_direct" &&
      action.execution_target.status === "wired" &&
      (action.action_id.startsWith("route.") ||
        action.execution_target.path === "route")
    ) {
      return true;
    }
  }

  // A goal authorization is honored only when it names THIS action's own
  // authored journey and the browser is standing on that journey's declared
  // destination. Both facts come from the generated contract, so the check
  // cannot be satisfied by a caller inventing a goal id for another action.
  const authorization = input.goalAuthorization;
  if (authorization && !routeIsBlockedByActiveLayer) {
    const journey = resolveNavigationJourney(input.actionId);
    if (
      journey &&
      authorization.goalId === journey.goalId &&
      authorization.expectedScreen === journey.destinationScreen &&
      input.appRuntimeState.route.screen === journey.destinationScreen
    ) {
      return true;
    }
  }

  if (input.allowedActionIds) {
    return input.allowedActionIds.includes(input.actionId);
  }
  const published = hasPublishedActionInventory(input.surfaceMetadata);
  return published.length === 0 || published.includes(input.actionId);
}

function unavailableOnActiveSurfaceResult(input: ExecuteAgentGatewayActionInput) {
  return buildResult({
    status: "blocked",
    actionId: input.actionId,
    routeBefore: input.appRuntimeState.route.pathname,
    screenBefore: input.appRuntimeState.route.screen,
    resultSummary: "That action is not available on this screen.",
    reason: "action_not_in_active_inventory",
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildResult(
  input: Partial<AgentActionRuntimeResult>,
): AgentActionRuntimeResult {
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

function buildLocalHandlerResult(input: {
  actionId: string;
  label: string;
  routeBefore: AppRuntimeState["route"];
  goalId: string;
  handlerResult: LocalOnboardingActionResult;
}): AgentActionRuntimeResult {
  // Every local handler result funnels through here, so this is the one place
  // that has to know about disambiguation.
  //
  // Publishing unconditionally is deliberate, including the null case: a
  // handler result that carries no candidates means the person has moved on --
  // most often by tapping a row, which runs this same path and should retire
  // the card that produced it. Clearing only on success would leave a stale
  // list of people on screen after the question stopped being live.
  publishVoiceCard(parseVoiceCard(input.handlerResult.data));

  return buildResult({
    status:
      input.handlerResult.status === "started"
        ? "started"
        : input.handlerResult.status === "succeeded"
          ? "succeeded"
          : input.handlerResult.status === "blocked"
            ? "blocked"
            : "failed",
    actionId: input.actionId,
    label: input.label,
    routeBefore: input.routeBefore.pathname,
    screenBefore: input.routeBefore.screen,
    routeAfter: input.handlerResult.routeAfter,
    screenAfter: input.handlerResult.screenAfter,
    resultSummary: input.handlerResult.summary,
    data: { ...(input.handlerResult.data || {}), goal_id: input.goalId },
  });
}

/**
 * Run an action that must consume the current browser activation.
 *
 * This function intentionally is not async. All contract and availability
 * checks are synchronous, and the mounted handler is invoked before the first
 * promise boundary so Firebase can open its provider popup from the Agent Bar
 * tap. The returned promise represents the provider's eventual settlement.
 */
export function executeTrustedActivationGatewayAction(
  input: ExecuteAgentGatewayActionInput,
): Promise<AgentActionRuntimeResult> {
  const routeBefore = input.appRuntimeState.route;
  if (!isActionInActiveInventory(input)) {
    return Promise.resolve(unavailableOnActiveSurfaceResult(input));
  }
  const action = getKaiActionById(input.actionId);
  if (!action) {
    return Promise.resolve(
      buildResult({
        status: "invalid",
        actionId: input.actionId,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: "Agent could not find that action.",
        reason: "missing_action",
      }),
    );
  }
  if (action.activation_policy !== "trusted_activation_required") {
    return Promise.resolve(
      buildResult({
        status: "invalid",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: "That action does not use trusted browser activation.",
        reason: "activation_policy_mismatch",
      }),
    );
  }
  const availability = evaluateKaiActionAvailability({
    action,
    appRuntimeState: input.appRuntimeState,
    surfaceMetadata: input.surfaceMetadata,
  });
  if (availability.status !== "available") {
    return Promise.resolve(
      buildResult({
        status: "blocked",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary:
          availability.blocked_guidance ||
          availability.reason ||
          "That action is not available right now.",
        reason: availability.status,
      }),
    );
  }
  if (
    action.execution_target.status !== "wired" ||
    action.execution_target.path !== "local_handler"
  ) {
    return Promise.resolve(
      buildResult({
        status: "invalid",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: "That browser action is not wired to a mounted control.",
        reason: "trusted_activation_target_invalid",
      }),
    );
  }
  if (
    typeof navigator !== "undefined" &&
    navigator.userActivation &&
    !navigator.userActivation.isActive
  ) {
    return Promise.resolve(
      buildResult({
        status: "blocked",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: `Tap ${action.label} again to open the secure provider window.`,
        reason: "trusted_activation_missing",
      }),
    );
  }
  const handler = resolveLocalOnboardingHandler(action.action_id);
  if (!handler) {
    return Promise.resolve(
      buildResult({
        status: "blocked",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: `${action.label} isn't mounted on this screen right now.`,
        reason: "local_handler_not_mounted",
      }),
    );
  }

  try {
    // Do not move this invocation behind an await or timer. It owns the trusted
    // Agent Bar tap that Firebase requires to create the popup.
    const settlement = handler(input.slots || {}, input.executionContext);
    return Promise.resolve(settlement)
      .then((handlerResult) =>
        buildLocalHandlerResult({
          actionId: action.action_id,
          label: action.label,
          routeBefore,
          goalId: action.goal.goal_id,
          handlerResult,
        }),
      )
      .catch((error: unknown) =>
        buildResult({
          status: "failed",
          actionId: action.action_id,
          label: action.label,
          routeBefore: routeBefore.pathname,
          screenBefore: routeBefore.screen,
          resultSummary:
            error instanceof Error && error.message
              ? error.message
              : `${action.label} failed to run.`,
          reason: "local_handler_error",
        }),
      );
  } catch (error) {
    return Promise.resolve(
      buildResult({
        status: "failed",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary:
          error instanceof Error && error.message
            ? error.message
            : `${action.label} failed to run.`,
        reason: "local_handler_error",
      }),
    );
  }
}

function storeConnectedSystemInstruction(
  actionId: string,
  slots: Record<string, unknown>,
) {
  if (typeof window === "undefined") return null;
  const instructionId = `crm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    window.sessionStorage.setItem(
      `hushh:connected-system-agent-action:${instructionId}`,
      JSON.stringify({
        actionId,
        slots,
        createdAt: new Date().toISOString(),
      }),
    );
    return instructionId;
  } catch {
    return null;
  }
}

function patchRuntimePersonaState(
  state: AppRuntimeState,
  targetPersona: Persona,
): AppRuntimeState {
  const available = new Set<Persona>([
    ...((state.persona.available || []) as Persona[]),
    targetPersona,
  ]);
  return {
    ...state,
    persona: {
      ...state.persona,
      active: targetPersona,
      primary_nav: targetPersona,
      available: Array.from(available),
      transition_target: null,
    },
  };
}

function canAutoSettlePersonaForAction(input: {
  targetPersona: Persona | null;
  actionPolicy: string;
  actionTargetStatus: string;
  requiresPersonaConfirmation: boolean;
  switchPersona?: (target: Persona) => Promise<unknown>;
}): boolean {
  return Boolean(
    input.targetPersona &&
    input.switchPersona &&
    input.actionPolicy === "allow_direct" &&
    input.actionTargetStatus === "wired" &&
    input.requiresPersonaConfirmation !== true,
  );
}

function executeConnectedSystemAgentAction(
  input: ExecuteAgentGatewayActionInput,
  routeBefore: AppRuntimeState["route"],
): AgentActionRuntimeResult | null {
  if (!input.actionId.startsWith("connected_system.crm.")) {
    return null;
  }
  if (input.actionId === "connected_system.crm.delete") {
    return buildResult({
      status: "blocked",
      actionId: input.actionId,
      label: "Blocked CRM Delete",
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary: "CRM delete is blocked in Agent v1.",
      reason: "crm_delete_manual_only",
    });
  }

  const slots = input.slots || {};
  const systemId = readString(slots.systemId);
  if (!systemId) {
    return buildResult({
      status: "blocked",
      actionId: input.actionId,
      label: "Select CRM",
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary: "Select a connected CRM before preparing this action.",
      reason: "connected_system_selection_required",
    });
  }
  const instructionId = storeConnectedSystemInstruction(input.actionId, slots);
  const target = buildConnectedSystemRoute(systemId, {
    agentActionId: instructionId,
  });
  input.router.push(target);
  return buildResult({
    status: "started",
    actionId: input.actionId,
    label:
      input.actionId === "connected_system.crm.read"
        ? "Read CRM Record"
        : input.actionId === "connected_system.crm.create.propose"
          ? "Propose CRM Create"
          : "Propose CRM Update",
    routeBefore: routeBefore.pathname,
    routeAfter: target,
    screenBefore: routeBefore.screen,
    screenAfter: "connected_systems",
    resultSummary: "Connected Systems opened for CRM.",
    data: {
      target,
      slots,
    },
  });
}

export async function executeAgentGatewayAction(
  input: ExecuteAgentGatewayActionInput,
): Promise<AgentActionRuntimeResult> {
  const routeBefore = input.appRuntimeState.route;
  if (!isActionInActiveInventory(input)) {
    return unavailableOnActiveSurfaceResult(input);
  }
  const connectedSystemResult = executeConnectedSystemAgentAction(
    input,
    routeBefore,
  );
  if (connectedSystemResult) {
    return connectedSystemResult;
  }

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

  let effectiveRuntimeState = input.appRuntimeState;
  const initialAvailability = evaluateKaiActionAvailability({
    action,
    appRuntimeState: input.appRuntimeState,
    surfaceMetadata: input.surfaceMetadata,
  });
  if (
    initialAvailability.status === "requires_persona_switch" &&
    initialAvailability.target_persona &&
    input.switchPersona &&
    canAutoSettlePersonaForAction({
      targetPersona: initialAvailability.target_persona,
      actionPolicy: action.execution_policy,
      actionTargetStatus: action.execution_target.status,
      requiresPersonaConfirmation:
        action.reachability.requires_persona_switch_confirmation,
      switchPersona: input.switchPersona,
    })
  ) {
    try {
      await input.switchPersona(initialAvailability.target_persona);
      effectiveRuntimeState = patchRuntimePersonaState(
        input.appRuntimeState,
        initialAvailability.target_persona,
      );
    } catch (error) {
      return buildResult({
        status: "blocked",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary:
          error instanceof Error && error.message
            ? error.message
            : "One could not switch workspaces for that action.",
        reason: "persona_switch_failed",
      });
    }
  }

  const availability = evaluateKaiActionAvailability({
    action,
    appRuntimeState: effectiveRuntimeState,
    surfaceMetadata: input.surfaceMetadata,
    allowPersonaRouteSettlement: true,
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
      data: {
        target: action.execution_target.target,
        goal_id: action.goal.goal_id,
      },
    });
  }

  if (action.execution_target.path === "local_handler") {
    if (input.signal?.aborted) {
      return buildResult({
        status: "failed",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: "Action was interrupted.",
        reason: "execution_aborted",
      });
    }

    const handler = await waitForLocalOnboardingHandler(action.action_id);
    if (!handler) {
      return buildResult({
        status: "blocked",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary: `${action.label} isn't available on this screen right now.`,
        reason: "local_handler_not_mounted",
      });
    }

    try {
      // A local handler may begin an external mutation (for example, sending a
      // connection request). The handler contract has no cancellation signal,
      // and its backing services do not promise rollback on abort. Racing it
      // against a local timeout or a later voice utterance would therefore
      // report a false terminal failure while the request can still succeed.
      // Once invocation begins, wait for the authoritative handler outcome;
      // the pre-invocation abort check above still avoids starting new work.
      const handlerResult = await handler(
        input.slots || {},
        input.executionContext,
      );

      return buildLocalHandlerResult({
        actionId: action.action_id,
        label: action.label,
        routeBefore,
        goalId: action.goal.goal_id,
        handlerResult,
      });
    } catch (error) {
      return buildResult({
        status: "failed",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary:
          error instanceof Error && error.message
            ? error.message
            : `${action.label} failed to run.`,
        reason: "local_handler_error",
      });
    }
  }

  // A small number of generated actions are surfaced by native voice tools
  // and also have a mounted web control (for example Analysis cancel/resume).
  // The mounted handler is still required by the active inventory gate above;
  // this is not a fallback to arbitrary DOM or off-screen execution.
  const mountedHandler = resolveLocalOnboardingHandler(action.action_id);
  if (mountedHandler) {
    try {
      const handlerResult = await mountedHandler(
        input.slots || {},
        input.executionContext,
      );
      return buildLocalHandlerResult({
        actionId: action.action_id,
        label: action.label,
        routeBefore,
        goalId: action.goal.goal_id,
        handlerResult,
      });
    } catch (error) {
      return buildResult({
        status: "failed",
        actionId: action.action_id,
        label: action.label,
        routeBefore: routeBefore.pathname,
        screenBefore: routeBefore.screen,
        resultSummary:
          error instanceof Error && error.message
            ? error.message
            : `${action.label} failed to run.`,
        reason: "local_handler_error",
      });
    }
  }

  if (action.execution_target.path !== "kai_command") {
    return buildResult({
      status: "blocked",
      actionId: action.action_id,
      label: action.label,
      routeBefore: routeBefore.pathname,
      screenBefore: routeBefore.screen,
      resultSummary:
        "That action belongs to the voice runtime and is not available in Agent text yet.",
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
    data: {
      ...(commandResult.actionResult.data || {}),
      goal_id: action.goal.goal_id,
    },
  });
}
