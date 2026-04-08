import {
  getInvestorKaiActionById,
  getInvestorKaiActionByVoiceToolCall,
  type InvestorKaiActionDefinition,
  type InvestorKaiActionId,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";
import type { StructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type { VoiceResponse, VoiceToolCall } from "@/lib/voice/voice-types";

export type GroundedExecutionStep =
  | {
      type: "navigate";
      href: string;
      reason: string;
    }
  | {
      type: "tool_call";
      toolCall: VoiceToolCall;
      reason: string;
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
  execution: GroundedExecutionPlan;
};

type ResolveGroundedPlanInput = {
  transcript: string;
  response: VoiceResponse;
  structuredContext?: StructuredScreenContext;
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

function isSameRouteTarget(currentHref: string, targetHref: string): boolean {
  const current = String(currentHref || "").trim();
  const target = String(targetHref || "").trim();
  if (!current || !target) return false;
  if (target.includes("?")) {
    return current === target;
  }
  return toPathnameFromHref(current) === toPathnameFromHref(target);
}

function defaultRouteForAction(action: InvestorKaiActionDefinition): string | null {
  if (action.scope.routes.length === 0) return null;
  const first = action.scope.routes[0];
  return typeof first === "string" && first.trim() ? first.trim() : null;
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
      params.tab = binding.params.tab;
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
    return "nav.profile_gmail_panel";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(pkm|pkm agent lab|memory lab)\b/.test(text)) {
    return "nav.profile_pkm_agent_lab";
  }
  if (/\b(open|show|go to|take me to)\b.*\bsupport\b/.test(text)) {
    return "nav.profile_support_panel";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(receipts?)\b/.test(text)) {
    return "nav.profile_receipts";
  }
  if (
    /\b(add|build|refresh|save)\b.*\b(receipts?)\b.*\bpkm\b/.test(text) ||
    /\b(receipts?)\b.*\b(memory|preview)\b/.test(text)
  ) {
    return "nav.profile_receipts";
  }
  if (/\b(open|show|go to|take me to)\b.*\b(security|vault security)\b/.test(text)) {
    return "nav.profile_security_panel";
  }
  if (/\b(open|show|go to|take me to)\b.*\binvestments?\b/.test(text)) {
    return "nav.kai_investments";
  }
  if (/\b(open|show|go to|take me to)\b.*\boptimi[sz]e\b/.test(text)) {
    return "nav.kai_optimize";
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
    return getInvestorKaiActionById("nav.kai_optimize");
  }

  return null;
}

function chooseCandidateAction(
  transcriptAction: InvestorKaiActionDefinition | null,
  responseAction: InvestorKaiActionDefinition | null
): InvestorKaiActionDefinition | null {
  if (responseAction) return responseAction;
  if (transcriptAction) return transcriptAction;
  return null;
}

export function resolveGroundedVoicePlan(input: ResolveGroundedPlanInput): GroundedVoicePlan {
  const transcriptActionId = inferActionIdFromTranscript(input.transcript);
  const transcriptAction = transcriptActionId
    ? getInvestorKaiActionById(transcriptActionId)
    : null;
  const responseAction = resolveActionFromResponse(input.response);
  const action = chooseCandidateAction(transcriptAction, responseAction);

  if (input.response.kind === "clarify" && input.response.reason === "ticker_ambiguous") {
    return {
      status: "ambiguous",
      actionId: action?.id ?? null,
      actionLabel: action?.label ?? null,
      destructive: Boolean(action && DESTRUCTIVE_ACTION_IDS.has(action.id)),
      message: input.response.message,
      execution: {
        mode: "ambiguous",
        steps: [],
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
      execution: {
        mode: "none",
        steps: [],
      },
    };
  }

  const destructive = DESTRUCTIVE_ACTION_IDS.has(action.id);
  if (destructive) {
    return {
      status: "manual_only",
      actionId: action.id,
      actionLabel: action.label,
      destructive: true,
      message: MANUAL_ONLY_MESSAGE,
      execution: {
        mode: "manual_only",
        steps: [
          {
            type: "prompt",
            message: MANUAL_ONLY_MESSAGE,
            reason: "destructive_action_policy",
          },
        ],
      },
    };
  }

  const currentHref = String(input.structuredContext?.route.pathname || "").trim();

  if (action.wiring.status === "dead") {
    return {
      status: "unavailable",
      actionId: action.id,
      actionLabel: action.label,
      destructive: false,
      message: UNAVAILABLE_MESSAGE,
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
    const targetHref = defaultRouteForAction(action);
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
      execution: {
        mode: steps.some((step) => step.type === "navigate")
          ? "navigate_then_action"
          : "manual_only",
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
    if (isSameRouteTarget(currentHref, binding.href)) {
      return {
        status: "resolved",
        actionId: action.id,
        actionLabel: action.label,
        destructive: false,
        message: null,
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
      execution: {
        mode: "navigate_only",
        steps: [
          {
            type: "navigate",
            href: binding.href,
            reason: "route_bound_action",
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

  const targetHref = defaultRouteForAction(action);
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
      execution: {
        mode: "navigate_then_action",
        steps: [
          {
            type: "navigate",
            href: targetHref,
            reason: "hidden_action_navigation_prerequisite",
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
