import {
  getInvestorKaiActionById,
  getInvestorKaiActionByVoiceToolCall,
  type InvestorKaiActionDefinition,
  type InvestorKaiActionId,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
} from "@/lib/voice/kai-action-gateway";
import type { StructuredScreenContext } from "@/lib/voice/screen-context-builder";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState, VoiceResponse, VoiceToolCall } from "@/lib/voice/voice-types";

export type GroundedSettlementTarget = {
  route?: string | null;
  screen?: string | null;
  persona?: string | null;
};

export type GroundedExecutionStep =
  | {
      type: "navigate";
      href: string;
      reason: string;
      settlementTarget?: GroundedSettlementTarget | null;
    }
  | {
      type: "tool_call";
      toolCall: VoiceToolCall;
      reason: string;
      confirmationRequired?: boolean;
      settlementTarget?: GroundedSettlementTarget | null;
    }
  | {
      type: "prompt";
      message: string;
      reason: string;
    };

export type GroundedExecutionPlan = {
  mode:
    | "none"
    | "direct_tool"
    | "navigate_only"
    | "navigate_then_action"
    | "manual_only"
    | "unavailable"
    | "ambiguous";
  steps: GroundedExecutionStep[];
};

export type GroundedVoicePlan = {
  status: "resolved" | "manual_only" | "unavailable" | "ambiguous" | "none";
  actionId: InvestorKaiActionId | null;
  actionLabel: string | null;
  destructive: boolean;
  message: string | null;
  resolutionSource: "canonical" | "response" | "transcript" | "none";
  execution: GroundedExecutionPlan;
};

type ResolveGroundedPlanInput = {
  transcript: string;
  response: VoiceResponse;
  structuredContext?: StructuredScreenContext;
  appRuntimeState?: AppRuntimeState;
  canonicalActionId?: string | null;
  allowCompatibilityFallback?: boolean;
};

const MANUAL_ONLY_MESSAGE = "Please do that yourself in the app.";
const UNAVAILABLE_MESSAGE = "I can’t do that right now.";

const DESTRUCTIVE_ACTION_IDS = new Set<InvestorKaiActionId>([
  "analysis.cancel_active",
  "profile.gmail.disconnect",
  "profile.sign_out",
  "profile.delete_account",
]);

function toPathnameFromHref(href: string): string {
  const value = String(href || "").trim();
  if (!value) return "";
  const queryIndex = value.indexOf("?");
  return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
}

function extractRiaRouteParams(currentHref: string): Record<string, string> {
  const pathname = toPathnameFromHref(currentHref);
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const params: Record<string, string> = {};
  if (segments[0] !== "ria" || segments[1] !== "clients" || !segments[2]) {
    return params;
  }
  params.userId = segments[2];
  const accountIndex = segments.indexOf("accounts");
  const accountId = accountIndex >= 0 ? segments[accountIndex + 1] : undefined;
  if (accountId) {
    params.accountId = accountId;
  }
  const requestIndex = segments.indexOf("requests");
  const requestId = requestIndex >= 0 ? segments[requestIndex + 1] : undefined;
  if (requestId) {
    params.requestId = requestId;
  }
  return params;
}

function resolveDynamicRouteHref(targetHref: string, currentHref: string): string | null {
  const href = String(targetHref || "").trim();
  if (!href) return null;
  if (!href.includes("[")) return href;

  const params = extractRiaRouteParams(currentHref);
  let resolved = href;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replaceAll(`[${key}]`, encodeURIComponent(value));
  }
  return resolved.includes("[") ? null : resolved;
}

function isSameRouteTarget(currentHref: string, targetHref: string): boolean {
  const current = String(currentHref || "").trim();
  const target = String(targetHref || "").trim();
  if (!current || !target) return false;
  if (target.includes("?")) {
    return current === target;
  }
  return toPathnameFromHref(current) === toPathnameFromHref(target);
}

function defaultRouteForAction(
  action: InvestorKaiActionDefinition,
  currentHref: string
): string | null {
  if (action.scope.routes.length === 0) return null;
  const first = action.scope.routes[0];
  if (typeof first !== "string" || !first.trim()) return null;
  return resolveDynamicRouteHref(first.trim(), currentHref);
}

function buildToolCallFromWiredAction(
  action: InvestorKaiActionDefinition,
  response: VoiceResponse
): VoiceToolCall | null {
  if (action.wiring.status !== "wired") return null;
  const binding = action.wiring.binding;
  if (binding.kind === "voice_tool") {
    if (response.kind === "execute" && response.tool_call.tool_name === binding.toolName) {
      return response.tool_call;
    }
    if (binding.toolName === "resume_active_analysis") {
      return { tool_name: "resume_active_analysis", args: {} };
    }
    if (binding.toolName === "cancel_active_analysis") {
      return { tool_name: "cancel_active_analysis", args: { confirm: false } };
    }
    if (binding.toolName === "navigate_back") {
      return { tool_name: "navigate_back", args: {} };
    }
    if (binding.toolName === "switch_persona") {
      return {
        tool_name: "switch_persona",
        args: {
          target_persona: "ria",
        },
      };
    }
    return null;
  }
  if (binding.kind === "kai_command") {
    if (response.kind === "execute" && response.tool_call.tool_name === "execute_kai_command") {
      if (response.tool_call.args.command === binding.command) {
        return response.tool_call;
      }
    }

    const params: {
      symbol?: string;
      focus?: "active";
      tab?: "history" | "debate" | "summary" | "transcript";
    } = {};

    if (binding.params?.requiresSymbol) {
      const responseSymbol =
        response.kind === "execute" && response.tool_call.tool_name === "execute_kai_command"
          ? response.tool_call.args.params?.symbol
          : null;
      if (!responseSymbol || !responseSymbol.trim()) {
        return null;
      }
      params.symbol = responseSymbol.trim().toUpperCase();
    }

    if (binding.params?.focus) {
      params.focus = binding.params.focus;
    }

    if (binding.params?.tab) {
      if (
        binding.params.tab === "history" ||
        binding.params.tab === "debate" ||
        binding.params.tab === "summary" ||
        binding.params.tab === "transcript"
      ) {
        params.tab = binding.params.tab;
      }
    }

    const normalizedParams = Object.keys(params).length > 0 ? params : undefined;
    return {
      tool_name: "execute_kai_command",
      args: {
        command: binding.command,
        params: normalizedParams,
      },
    };
  }
  return null;
}

function toSettlementTarget(
  input:
    | {
        route?: string;
        screen?: string;
        persona?: string;
      }
    | null
    | undefined
): GroundedSettlementTarget | null {
  if (!input) return null;
  const target: GroundedSettlementTarget = {
    route: input.route || null,
    screen: input.screen || null,
    persona: input.persona || null,
  };
  return target.route || target.screen || target.persona ? target : null;
}

function buildToolCallFromWorkflowStep(step: {
  tool_name: VoiceToolCall["tool_name"];
  args?: Record<string, unknown>;
}): VoiceToolCall {
  if (step.tool_name === "execute_kai_command") {
    const args = (step.args || {}) as Record<string, unknown>;
    return {
      tool_name: "execute_kai_command",
      args: {
        command: String(args.command || "home") as "analyze" | "optimize" | "import" | "consent" | "profile" | "history" | "dashboard" | "home",
        params:
          args.params && typeof args.params === "object"
            ? (args.params as {
                symbol?: string;
                focus?: "active";
                tab?: "history" | "debate" | "summary" | "transcript";
              })
            : undefined,
      },
    };
  }
  return {
    tool_name: step.tool_name,
    args: (step.args || {}) as never,
  } as VoiceToolCall;
}

function buildWorkflowSteps(
  action: InvestorKaiActionDefinition,
  currentHref: string,
  currentPersona: string | null
): GroundedExecutionStep[] {
  if (!action.workflow) return [];
  const steps: GroundedExecutionStep[] = [];
  for (const step of action.workflow.steps) {
    if (step.type === "route_switch") {
      if (isSameRouteTarget(currentHref, step.href)) {
        continue;
      }
      steps.push({
        type: "navigate",
        href: step.href,
        reason: "workflow_route_switch",
        settlementTarget: toSettlementTarget(step.settlement_target),
      });
      continue;
    }
    if (step.type === "persona_switch") {
      if (currentPersona === step.target_persona) {
        continue;
      }
      steps.push({
        type: "tool_call",
        toolCall: {
          tool_name: "switch_persona",
          args: {
            target_persona: step.target_persona,
          },
        },
        reason: step.reason || "workflow_persona_switch",
        confirmationRequired: step.confirmation_required === true,
        settlementTarget: toSettlementTarget(step.settlement_target),
      });
      continue;
    }
    if (step.type === "tool_call") {
      steps.push({
        type: "tool_call",
        toolCall: buildToolCallFromWorkflowStep(step),
        reason: step.reason || "workflow_tool_call",
        confirmationRequired: step.confirmation_required === true,
        settlementTarget: toSettlementTarget(step.settlement_target),
      });
      continue;
    }
    steps.push({
      type: "prompt",
      message: step.message,
      reason: "workflow_prompt",
    });
  }
  return steps;
}

function inferActionIdFromTranscript(transcript: string): InvestorKaiActionId | null {
  const text = String(transcript || "").trim().toLowerCase();
  if (!text) return null;

  if (/\b(delete|erase|remove)\s+(my\s+)?account\b/.test(text)) {
    return "profile.delete_account";
  }
  if (/\b(sign|log)\s*out\b/.test(text)) {
    return "profile.sign_out";
  }
  if (/\bdisconnect\b.*\bgmail\b|\bgmail\b.*\bdisconnect\b/.test(text)) {
    return "profile.gmail.disconnect";
  }
  if (/\bcancel\b.*\b(analysis|debate|run)\b|\bstop\b.*\b(analysis|debate|run)\b/.test(text)) {
    return "analysis.cancel_active";
  }

  if (/\b(open|show|go to|take me to)\b.*\bgmail\b/.test(text)) {
    return "route.profile_gmail_panel";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(pkm|pkm agent lab|memory lab)\b/.test(text)) {
    return "route.profile_pkm_agent_lab";
  }
  if (/\b(open|show|go to|take me to)\b.*\bsupport\b/.test(text)) {
    return "route.profile_support_panel";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(receipts?)\b/.test(text)) {
    return "route.profile_receipts";
  }
  if (
    /\b(add|build|refresh|save)\b.*\b(receipts?)\b.*\bpkm\b/.test(text) ||
    /\b(receipts?)\b.*\b(memory|preview)\b/.test(text)
  ) {
    return "route.profile_receipts";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(security|vault security)\b/.test(text)) {
    return "route.profile_security_panel";
  }
  if (
    /\b(open|show|go to|take me to)\b.*\b(analysis history|analysis tab history|past analys(?:is|es)|analysis archive)\b/.test(
      text
    )
  ) {
    return "route.analysis_history";
  }
  if (
    /\b(open|show|go to|take me to)\b.*\b(analysis|analysis section|analysis screen|research)\b/.test(
      text
    )
  ) {
    return "route.kai_analysis";
  }
  if (/\b(open|show|go to|take me to)\b.*\binvestments?\b/.test(text)) {
    return "route.kai_investments";
  }
  if (/\b(open|show|go to|take me to)\b.*\boptimi[sz]e\b/.test(text)) {
    return "route.kai_optimize";
  }
  if (/\b(sync|refresh)\b.*\bgmail\b.*\b(receipts?)?\b/.test(text)) {
    return "profile.gmail.sync_now";
  }
  return null;
}

function resolveActionFromResponse(response: VoiceResponse): InvestorKaiActionDefinition | null {
  if (response.kind !== "execute") return null;
  const mapped = getInvestorKaiActionByVoiceToolCall(response.tool_call);
  if (mapped) return mapped;

  if (
    response.tool_call.tool_name === "execute_kai_command" &&
    response.tool_call.args.command === "optimize"
  ) {
    return getInvestorKaiActionById("route.kai_optimize");
  }

  return null;
}

function chooseCandidateAction(
  canonicalAction: InvestorKaiActionDefinition | null,
  transcriptAction: InvestorKaiActionDefinition | null,
  responseAction: InvestorKaiActionDefinition | null
): {
  action: InvestorKaiActionDefinition | null;
  source: GroundedVoicePlan["resolutionSource"];
} {
  if (canonicalAction) {
    return {
      action: canonicalAction,
      source: "canonical",
    };
  }
  if (responseAction) {
    return {
      action: responseAction,
      source: "response",
    };
  }
  if (transcriptAction) {
    return {
      action: transcriptAction,
      source: "transcript",
    };
  }
  return {
    action: null,
    source: "none",
  };
}

export function resolveGroundedVoicePlan(input: ResolveGroundedPlanInput): GroundedVoicePlan {
  const compatibilityFallbackEnabled = input.allowCompatibilityFallback !== false;
  const canonicalActionId =
    typeof input.canonicalActionId === "string" && input.canonicalActionId.trim()
      ? (input.canonicalActionId.trim() as InvestorKaiActionId)
      : null;
  const canonicalAction = canonicalActionId
    ? getInvestorKaiActionById(canonicalActionId)
    : null;
  const transcriptActionId = compatibilityFallbackEnabled
    ? inferActionIdFromTranscript(input.transcript)
    : null;
  const transcriptAction = transcriptActionId ? getInvestorKaiActionById(transcriptActionId) : null;
  const responseAction = compatibilityFallbackEnabled ? resolveActionFromResponse(input.response) : null;
  const candidate = canonicalActionId
    ? canonicalAction
      ? {
          action: canonicalAction,
          source: "canonical" as const,
        }
      : {
          action: null,
          source: "canonical" as const,
        }
    : chooseCandidateAction(canonicalAction, transcriptAction, responseAction);
  const action = candidate.action;
  const currentHref = String(input.structuredContext?.route.pathname || "").trim();
  const currentPersona = String(input.appRuntimeState?.persona.active || "").trim() || null;

  if (input.response.kind === "clarify" && input.response.reason === "ticker_ambiguous") {
    return {
      status: "ambiguous",
      actionId: action?.id ?? null,
      actionLabel: action?.label ?? null,
      destructive: Boolean(action && DESTRUCTIVE_ACTION_IDS.has(action.id)),
      message: input.response.message,
      resolutionSource: candidate.source,
      execution: {
        mode: "ambiguous",
        steps: [],
      },
    };
  }

  if (canonicalActionId && !canonicalAction) {
    return {
      status: "unavailable",
      actionId: canonicalActionId,
      actionLabel: null,
      destructive: false,
      message: UNAVAILABLE_MESSAGE,
      resolutionSource: "canonical",
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message: UNAVAILABLE_MESSAGE,
            reason: "canonical_action_not_found",
          },
        ],
      },
    };
  }

  if (!action) {
    return {
      status: "none",
      actionId: null,
      actionLabel: null,
      destructive: false,
      message: null,
      resolutionSource: "none",
      execution: {
        mode: "none",
        steps: [],
      },
    };
  }

  const availability = evaluateKaiActionAvailability({
    action: getKaiActionById(action.id)!,
    appRuntimeState: input.appRuntimeState,
    surfaceMetadata: getVoiceSurfaceMetadata(),
  });
  const destructive = DESTRUCTIVE_ACTION_IDS.has(action.id);
  if (destructive || availability.status === "manual_only") {
    const manualOnlyMessage = destructive
      ? MANUAL_ONLY_MESSAGE
      : availability.reason || MANUAL_ONLY_MESSAGE;
    return {
      status: "manual_only",
      actionId: action.id,
      actionLabel: action.label,
      destructive,
      message: manualOnlyMessage,
      resolutionSource: candidate.source,
      execution: {
        mode: "manual_only",
        steps: [
          {
            type: "prompt",
            message: manualOnlyMessage,
            reason: "destructive_action_policy",
          },
        ],
      },
    };
  }

  if (availability.status === "dead" || availability.status === "blocked") {
    const message = availability.reason || availability.blocked_guidance || UNAVAILABLE_MESSAGE;
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message,
      resolutionSource: candidate.source,
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message,
            reason: availability.status,
          },
        ],
      },
    };
  }

  if (availability.status === "requires_persona_switch" && !action.workflow) {
    const message = availability.reason || "Switch workspaces before running that action.";
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message,
      resolutionSource: candidate.source,
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message,
            reason: "persona_switch_required_without_workflow",
          },
        ],
      },
    };
  }

  if (action.wiring.status === "dead") {
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: UNAVAILABLE_MESSAGE,
      resolutionSource: candidate.source,
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message: UNAVAILABLE_MESSAGE,
            reason: action.wiring.reason,
          },
        ],
      },
    };
  }

  if (action.wiring.status === "unwired") {
    const targetHref = defaultRouteForAction(action, currentHref);
    const steps: GroundedExecutionStep[] = [];
    if (targetHref && !isSameRouteTarget(currentHref, targetHref)) {
      steps.push({
        type: "navigate",
        href: targetHref,
        reason: "hidden_action_navigation_prerequisite",
      });
    }
    steps.push({
      type: "prompt",
      message: "I opened the right screen. Please do that yourself in the app.",
      reason: "unwired_action_requires_manual_completion",
    });
    return {
      status: "resolved",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: "I opened the right screen. Please do that yourself in the app.",
      resolutionSource: candidate.source,
      execution: {
        mode: steps.some((step) => step.type === "navigate")
          ? "navigate_then_action"
          : "manual_only",
        steps,
      },
    };
  }

  if (action.workflow) {
    const steps = buildWorkflowSteps(action, currentHref, currentPersona);
    if (steps.length === 0) {
      return {
        status: "resolved",
        actionId: action.id,
        actionLabel: action.label,
        destructive: false,
        message: null,
        resolutionSource: candidate.source,
        execution: {
          mode: "navigate_only",
          steps: [],
        },
      };
    }
    return {
      status: "resolved",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: null,
      resolutionSource: candidate.source,
      execution: {
        mode:
          steps.some((step) => step.type === "navigate") &&
          steps.some((step) => step.type === "tool_call")
            ? "navigate_then_action"
            : steps.some((step) => step.type === "navigate")
              ? "navigate_only"
              : "direct_tool",
        steps,
      },
    };
  }

  const resolution = resolveInvestorKaiActionWiring(action);
  if (!resolution.resolvable) {
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: UNAVAILABLE_MESSAGE,
      resolutionSource: candidate.source,
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message: UNAVAILABLE_MESSAGE,
            reason: resolution.reason,
          },
        ],
      },
    };
  }

  const binding = action.wiring.binding;
  if (binding.kind === "route") {
    const routeHref = resolveDynamicRouteHref(binding.href, currentHref);
    if (!routeHref) {
      return {
        status: "manual_only",
        actionId: action.id,
        actionLabel: action.label,
        destructive: false,
        message: "Please choose the exact item on screen.",
        resolutionSource: candidate.source,
        execution: {
          mode: "manual_only",
          steps: [
            {
              type: "prompt",
              message: "Please choose the exact item on screen.",
              reason: "dynamic_route_parameter_missing",
            },
          ],
        },
      };
    }
    if (isSameRouteTarget(currentHref, routeHref)) {
      return {
        status: "resolved",
        actionId: action.id,
        actionLabel: action.label,
        destructive: false,
        message: null,
        resolutionSource: candidate.source,
        execution: {
          mode: "navigate_only",
          steps: [],
        },
      };
    }
    return {
      status: "resolved",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: null,
      resolutionSource: candidate.source,
      execution: {
        mode: "navigate_only",
          steps: [
          {
            type: "navigate",
            href: routeHref,
            reason: "route_bound_action",
            settlementTarget: {
              route: routeHref,
              screen: action.scope.screens[0] || null,
            },
          },
        ],
      },
    };
  }

  const toolCall = buildToolCallFromWiredAction(action, input.response);
  if (!toolCall) {
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: UNAVAILABLE_MESSAGE,
      resolutionSource: candidate.source,
      execution: {
        mode: "unavailable",
        steps: [
          {
            type: "prompt",
            message: UNAVAILABLE_MESSAGE,
            reason: "tool_call_not_buildable",
          },
        ],
      },
    };
  }

  const targetHref = defaultRouteForAction(action, currentHref);
  const requiresHiddenNavigation =
    action.scope.hiddenNavigable &&
    targetHref &&
    !isSameRouteTarget(currentHref, targetHref);

  if (requiresHiddenNavigation) {
    return {
      status: "resolved",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: null,
      resolutionSource: candidate.source,
      execution: {
        mode: "navigate_then_action",
        steps: [
          {
            type: "navigate",
            href: targetHref,
            reason: "hidden_action_navigation_prerequisite",
            settlementTarget: {
              route: targetHref,
              screen: action.scope.screens[0] || null,
            },
          },
          {
            type: "tool_call",
            toolCall,
            reason: "wired_tool_after_navigation",
          },
        ],
      },
    };
  }

  return {
    status: "resolved",
    actionId: action.id,
    actionLabel: action.label,
    destructive: false,
    message: null,
    resolutionSource: candidate.source,
    execution: {
      mode: "direct_tool",
      steps: [
        {
          type: "tool_call",
          toolCall,
          reason: "wired_tool_action",
        },
      ],
    },
  };
}

export const VOICE_MANUAL_ONLY_MESSAGE = MANUAL_ONLY_MESSAGE;
export const VOICE_UNAVAILABLE_MESSAGE = UNAVAILABLE_MESSAGE;
