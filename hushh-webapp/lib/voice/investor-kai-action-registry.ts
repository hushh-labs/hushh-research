import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import type { Persona } from "@/lib/services/ria-service";
import type { VoiceToolCall } from "@/lib/voice/voice-types";
import {
  getKaiActionById,
  getKaiActionByVoiceToolCall,
  listKaiActions,
  listKaiActionsForSurface,
  type KaiActionDefinition,
  type KaiActionExecutionPolicy,
  type KaiActionExecutionTarget,
  type KaiActionRiskLevel,
  type KaiActionWorkflow,
} from "@/lib/voice/kai-action-gateway";

export type InvestorKaiTriggerType = "voice" | "tap" | "keyboard" | "programmatic";
export type InvestorKaiRiskLevel = KaiActionRiskLevel;
export type InvestorKaiExecutionPolicy = KaiActionExecutionPolicy;
export type InvestorKaiScreenScope = string;
export type InvestorKaiGuardId = string;
export type InvestorKaiBackendEffect = {
  api: string;
  effect: string;
};

export type InvestorKaiActionWiring =
  | {
      status: "wired";
      handler: "executeKaiCommand" | "dispatchVoiceToolCall" | "router.push";
      binding:
        | {
            kind: "kai_command";
            command: KaiCommandAction;
            params?: {
              tab?: string;
              focus?: "active";
              requiresSymbol?: boolean;
            };
          }
        | {
            kind: "voice_tool";
            toolName: VoiceToolCall["tool_name"];
          }
        | {
            kind: "route";
            href: string;
          };
    }
  | {
      status: "unwired";
      reason: string;
      intendedHandler?: "executeKaiCommand" | "dispatchVoiceToolCall" | "router.push";
    }
  | {
      status: "dead";
      reason: string;
      legacyHandler?: "executeKaiCommand" | "dispatchVoiceToolCall";
    };

export type InvestorKaiActionDefinition = {
  id: string;
  surfaceId: string;
  label: string;
  aliases: readonly string[];
  searchKeywords: readonly string[];
  meaning: string;
  scope: {
    routes: readonly string[];
    screens: readonly InvestorKaiScreenScope[];
    hiddenNavigable: boolean;
    navigationPrerequisites: readonly string[];
    activePersonas: readonly Persona[];
    requiresPersonaSwitchConfirmation: boolean;
  };
  trigger: {
    primary: InvestorKaiTriggerType;
    supported: readonly InvestorKaiTriggerType[];
  };
  guards: ReadonlyArray<{
    id: InvestorKaiGuardId;
    description: string;
  }>;
  expectedEffects: {
    stateChanges: readonly string[];
    backendEffects: readonly InvestorKaiBackendEffect[];
  };
  risk: {
    level: InvestorKaiRiskLevel;
    executionPolicy: InvestorKaiExecutionPolicy;
  };
  wiring: InvestorKaiActionWiring;
  workflow: KaiActionWorkflow;
  controlIds: readonly string[];
  stateExposure: readonly string[];
  mapReferences: readonly string[];
};

const DEFAULT_TRIGGER: InvestorKaiActionDefinition["trigger"] = {
  primary: "voice",
  supported: ["voice", "tap", "keyboard", "programmatic"],
};

const KNOWN_KAI_COMMANDS: readonly KaiCommandAction[] = [
  "analyze",
  "optimize",
  "import",
  "consent",
  "profile",
  "history",
  "dashboard",
  "home",
];

const KNOWN_VOICE_TOOLS: readonly VoiceToolCall["tool_name"][] = [
  "execute_kai_command",
  "navigate_back",
  "resume_active_analysis",
  "cancel_active_analysis",
  "clarify",
  "switch_persona",
];

function describeGuard(guardId: string): string {
  switch (guardId) {
    case "auth_signed_in":
      return "User must be signed in.";
    case "vault_unlocked":
      return "Vault must be unlocked.";
    case "portfolio_required":
      return "Portfolio data must already exist.";
    case "analysis_idle_required":
      return "Analysis must be idle first.";
    case "active_analysis_required":
      return "An active analysis must already exist.";
    case "explicit_user_confirmation":
      return "Explicit confirmation is required.";
    case "manual_user_execution":
      return "User must complete this action manually.";
    case "gmail_configured":
      return "Gmail configuration must be available.";
    case "gmail_connected":
      return "Gmail must already be connected.";
    case "ria_persona_available":
      return "RIA workspace must be available for this account.";
    default:
      return guardId.replaceAll("_", " ");
  }
}

function toWiring(executionTarget: KaiActionExecutionTarget): InvestorKaiActionWiring {
  if (executionTarget.status === "dead") {
    return {
      status: "dead",
      reason: executionTarget.reason,
    };
  }
  if (executionTarget.status === "unwired") {
    return {
      status: "unwired",
      reason: executionTarget.reason,
      intendedHandler:
        executionTarget.intended_handler === "executeKaiCommand" ||
        executionTarget.intended_handler === "dispatchVoiceToolCall" ||
        executionTarget.intended_handler === "router.push"
          ? executionTarget.intended_handler
          : undefined,
    };
  }

  if (executionTarget.path === "kai_command") {
    return {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: executionTarget.target as KaiCommandAction,
        params: executionTarget.params
          ? {
              tab:
                typeof executionTarget.params.tab === "string"
                  ? executionTarget.params.tab
                  : undefined,
              focus:
                executionTarget.params.focus === "active"
                  ? executionTarget.params.focus
                  : undefined,
              requiresSymbol:
                typeof executionTarget.params.requires_symbol === "boolean"
                  ? executionTarget.params.requires_symbol
                  : undefined,
            }
          : undefined,
      },
    };
  }

  if (executionTarget.path === "voice_tool") {
    return {
      status: "wired",
      handler: "dispatchVoiceToolCall",
      binding: {
        kind: "voice_tool",
        toolName: executionTarget.target as VoiceToolCall["tool_name"],
      },
    };
  }

  return {
    status: "wired",
    handler: "router.push",
    binding: {
      kind: "route",
      href: executionTarget.target,
    },
  };
}

function toRegistryAction(action: KaiActionDefinition): InvestorKaiActionDefinition {
  return {
    id: action.action_id,
    surfaceId: action.surface_id,
    label: action.label,
    aliases: action.aliases,
    searchKeywords: action.search_keywords,
    meaning: action.meaning,
    scope: {
      routes: action.reachability.routes,
      screens: action.reachability.screens,
      hiddenNavigable: action.reachability.hidden_navigable,
      navigationPrerequisites: action.reachability.navigation_prerequisites,
      activePersonas: action.reachability.active_personas,
      requiresPersonaSwitchConfirmation:
        action.reachability.requires_persona_switch_confirmation,
    },
    trigger: action.trigger || DEFAULT_TRIGGER,
    guards: action.guard_ids.map((guardId) => ({
      id: guardId,
      description: describeGuard(guardId),
    })),
    expectedEffects: {
      stateChanges: action.expected_effects.state_changes,
      backendEffects: action.expected_effects.backend_effects,
    },
    risk: {
      level: action.risk_level,
      executionPolicy: action.execution_policy,
    },
    wiring: toWiring(action.execution_target),
    workflow: action.workflow,
    controlIds: action.control_ids,
    stateExposure: action.state_exposure,
    mapReferences: action.docs_references,
  };
}

export const INVESTOR_KAI_ACTION_REGISTRY: readonly InvestorKaiActionDefinition[] = listKaiActions()
  .map((action) => toRegistryAction(action));

export type InvestorKaiActionId = string;

const ACTIONS_BY_ID = new Map(
  INVESTOR_KAI_ACTION_REGISTRY.map((action) => [action.id, action] as const)
);

const ACTIONS_BY_KAI_COMMAND = new Map<KaiCommandAction, InvestorKaiActionDefinition>(
  INVESTOR_KAI_ACTION_REGISTRY.flatMap((action) => {
    if (action.wiring.status !== "wired" || action.wiring.binding.kind !== "kai_command") {
      return [];
    }
    return [[action.wiring.binding.command, action] as const];
  })
);

export function getInvestorKaiActionById(
  id: InvestorKaiActionId | string
): InvestorKaiActionDefinition | null {
  return ACTIONS_BY_ID.get(id) || null;
}

export function getInvestorKaiActionByKaiCommand(
  command: KaiCommandAction
): InvestorKaiActionDefinition | null {
  return ACTIONS_BY_KAI_COMMAND.get(command) || null;
}

export function getInvestorKaiActionByVoiceToolCall(
  toolCall: VoiceToolCall
): InvestorKaiActionDefinition | null {
  const action = getKaiActionByVoiceToolCall(toolCall);
  return action ? toRegistryAction(action) : null;
}

export function resolveInvestorKaiActionWiring(action: InvestorKaiActionDefinition): {
  resolvable: boolean;
  reason: string;
} {
  if (action.wiring.status !== "wired") {
    return {
      resolvable: false,
      reason: action.wiring.reason,
    };
  }

  const binding = action.wiring.binding;
  if (binding.kind === "kai_command") {
    return {
      resolvable: KNOWN_KAI_COMMANDS.includes(binding.command),
      reason: KNOWN_KAI_COMMANDS.includes(binding.command)
        ? "resolved via executeKaiCommand"
        : "unknown kai command binding",
    };
  }

  if (binding.kind === "voice_tool") {
    return {
      resolvable: KNOWN_VOICE_TOOLS.includes(binding.toolName),
      reason: KNOWN_VOICE_TOOLS.includes(binding.toolName)
        ? "resolved via dispatchVoiceToolCall"
        : "unknown voice tool binding",
    };
  }

  return {
    resolvable: binding.href.startsWith("/"),
    reason: binding.href.startsWith("/") ? "resolved via router.push" : "invalid route href",
  };
}

export function listInvestorKaiActionsForSurface(input: {
  screen?: string | null;
  href?: string | null;
  pathname?: string | null;
}): readonly InvestorKaiActionDefinition[] {
  return listKaiActionsForSurface(input).map((action) => toRegistryAction(action));
}

export function listInvestorKaiActions(): readonly InvestorKaiActionDefinition[] {
  return INVESTOR_KAI_ACTION_REGISTRY;
}

export function getInvestorKaiSourceAction(actionId: string): KaiActionDefinition | null {
  return getKaiActionById(actionId);
}
