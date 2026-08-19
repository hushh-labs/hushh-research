import gatewayJson from "@/contracts/kai/kai-action-gateway.vnext.json";

import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import type { Persona } from "@/lib/services/ria-service";
import type { AppRuntimeState, VoiceToolCall } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export type KaiActionRiskLevel = "low" | "medium" | "high";
export type KaiActionExecutionPolicy =
  "allow_direct" | "confirm_required" | "manual_only";
export type KaiActionActivationPolicy = "none" | "trusted_activation_required";
export type KaiActionSpeakerPersona = "one" | "kai" | "nav" | "kyc";
export type KaiActionDelegateAgentId =
  | "one"
  | "kai"
  | "nav"
  | "agent_kyc"
  | "agent_nav"
  | "agent_connected_systems"
  | "agent_connections"
  | "agent_email"
  | "agent_location";
export type KaiActionExecutionTarget =
  | {
      status: "wired";
      path: "kai_command" | "voice_tool" | "route" | "local_handler";
      target: string;
      params?: Record<string, unknown>;
    }
  | {
      status: "unwired";
      reason: string;
      intended_handler?: string;
    }

export type KaiActionWorkflowStep =
  | {
      type: "route_switch";
      href: string;
      preconditions: string[];
      postconditions: string[];
      failure_behavior: "stop" | "continue";
      settlement_target?: {
        route?: string;
        screen?: string;
        persona?: string;
      } | null;
    }
  | {
      type: "persona_switch";
      target_persona: Persona;
      confirmation_required?: boolean;
      reason?: string;
      preconditions: string[];
      postconditions: string[];
      failure_behavior: "stop" | "continue";
      settlement_target?: {
        route?: string;
        screen?: string;
        persona?: string;
      } | null;
    }
  | {
      type: "tool_call";
      tool_name: VoiceToolCall["tool_name"];
      args?: Record<string, unknown>;
      confirmation_required?: boolean;
      reason?: string;
      preconditions: string[];
      postconditions: string[];
      failure_behavior: "stop" | "continue";
      settlement_target?: {
        route?: string;
        screen?: string;
        persona?: string;
      } | null;
    }
  | {
      type: "prompt";
      message: string;
      preconditions: string[];
      postconditions: string[];
      failure_behavior: "stop" | "continue";
      settlement_target?: {
        route?: string;
        screen?: string;
        persona?: string;
      } | null;
    };

export type KaiActionWorkflow = {
  workflow_id: string;
  confirmation_required: boolean;
  failure_message?: string | null;
  blocked_guidance?: string | null;
  steps: KaiActionWorkflowStep[];
} | null;

export type KaiGoalRequiredInput = {
  name: string;
  prompt: string;
  required: boolean;
  slot?: string;
  resolver?: string;
  default_value?: string;
  options?: string[];
};

export type KaiGoalWorkflowStep = {
  type: string;
  label: string;
  failure_behavior: "stop" | "continue";
  action_id?: string;
  service?: string;
  slots?: Record<string, unknown>;
  settlement_target?: {
    route?: string;
    screen?: string;
    persona?: string;
  } | null;
};

export type KaiActionGoal = {
  goal_id: string;
  required_inputs: KaiGoalRequiredInput[];
  input_resolvers: string[];
  slot_schema: Record<string, unknown>;
  workflow_steps: KaiGoalWorkflowStep[];
  progress_contract: Record<string, unknown>;
  cancellation_contract: {
    cancellable?: boolean;
    cancel_action_id?: string | null;
    [key: string]: unknown;
  };
  result_contract: {
    summary_mode?: string;
    [key: string]: unknown;
  };
  entrypoint_support: string[];
};

export type KaiActionExternalCallback = {
  provider: "google" | "apple";
  starts: "external_redirect_started";
  settlement: "firebase_redirect_callback";
  failure_behavior: "retain_goal_and_retry";
  return_to: string;
};

export type KaiActionDefinition = {
  action_id: string;
  surface_id: string;
  label: string;
  aliases: string[];
  search_keywords: string[];
  meaning: string;
  speaker_persona: KaiActionSpeakerPersona;
  delegate_agent_id: KaiActionDelegateAgentId | null;
  reachability: {
    routes: string[];
    screens: string[];
    hidden_navigable: boolean;
    navigation_prerequisites: string[];
    active_personas: Persona[];
    requires_persona_switch_confirmation: boolean;
  };
  guard_ids: string[];
  risk_level: KaiActionRiskLevel;
  execution_policy: KaiActionExecutionPolicy;
  activation_policy: KaiActionActivationPolicy;
  execution_target: KaiActionExecutionTarget;
  control_ids: string[];
  state_exposure: string[];
  docs_references: string[];
  workflow: KaiActionWorkflow;
  external_callback: KaiActionExternalCallback | null;
  goal: KaiActionGoal;
  expected_effects: {
    state_changes: string[];
    backend_effects: Array<{
      api: string;
      effect: string;
    }>;
  };
  trigger: {
    primary: "voice" | "tap" | "keyboard" | "programmatic";
    supported: Array<"voice" | "tap" | "keyboard" | "programmatic">;
  };
};

type WiredKaiActionDefinition = KaiActionDefinition & {
  execution_target: Extract<KaiActionExecutionTarget, { status: "wired" }>;
};

export type KaiActionSurfaceDefinition = {
  schema_version: string;
  surface_id: string;
  surface_title: string;
  docs_references: string[];
  contract_file: string;
  defaults?: Record<string, unknown>;
};

export type KaiActionGateway = {
  schema_version: string;
  generator?: string;
  generated_at?: string;
  source_contracts?: string[];
  surfaces: KaiActionSurfaceDefinition[];
  actions: KaiActionDefinition[];
};

export type KaiActionAvailability =
  | {
      status: "available";
      reason: null;
      target_persona: null;
      blocked_guidance: null;
    }
  | {
      status: "requires_persona_switch";
      reason: string;
      target_persona: Persona;
      blocked_guidance: string | null;
    }
  | {
      status: "manual_only" | "unwired" | "dead" | "blocked";
      reason: string;
      target_persona: Persona | null;
      blocked_guidance: string | null;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function validateSpeakerPersona(value: unknown): KaiActionSpeakerPersona {
  const normalized = cleanString(value);
  if (normalized === "kai" || normalized === "nav" || normalized === "kyc")
    return normalized;
  return "one";
}

function validateDelegateAgentId(
  value: unknown,
): KaiActionDelegateAgentId | null {
  const normalized = cleanString(value);
  if (
    normalized === "one" ||
    normalized === "kai" ||
    normalized === "nav" ||
    normalized === "agent_kyc" ||
    normalized === "agent_nav" ||
    normalized === "agent_connected_systems" ||
    normalized === "agent_connections" ||
    normalized === "agent_email" ||
    normalized === "agent_location"
  ) {
    return normalized;
  }
  return null;
}

function validateExecutionTarget(
  value: unknown,
): KaiActionExecutionTarget | null {
  if (!isPlainObject(value)) return null;
  const status = cleanString(value.status);
  if (status === "wired") {
    const path = cleanString(value.path);
    const target = cleanString(value.target);
    if (
      (path !== "kai_command" &&
        path !== "voice_tool" &&
        path !== "route" &&
        path !== "local_handler") ||
      !target
    ) {
      return null;
    }
    return {
      status,
      path,
      target,
      params: isPlainObject(value.params) ? value.params : undefined,
    };
  }
  if (status === "unwired") {
    const reason = cleanString(value.reason);
    if (!reason) return null;
    return {
      status,
      reason,
      intended_handler: cleanString(value.intended_handler) || undefined,
    };
  }
  return null;
}

function validateWorkflowStep(value: unknown): KaiActionWorkflowStep | null {
  if (!isPlainObject(value)) return null;
  const type = cleanString(value.type);
  if (!type) return null;
  const preconditions = isStringArray(value.preconditions)
    ? value.preconditions
    : [];
  const postconditions = isStringArray(value.postconditions)
    ? value.postconditions
    : [];
  const failureBehavior =
    value.failure_behavior === "continue" ? "continue" : "stop";
  const settlementTarget = isPlainObject(value.settlement_target)
    ? {
        route: cleanString(value.settlement_target.route) || undefined,
        screen: cleanString(value.settlement_target.screen) || undefined,
        persona: cleanString(value.settlement_target.persona) || undefined,
      }
    : undefined;

  if (type === "route_switch") {
    const href = cleanString(value.href);
    if (!href) return null;
    return {
      type,
      href,
      preconditions,
      postconditions,
      failure_behavior: failureBehavior,
      settlement_target: settlementTarget,
    };
  }
  if (type === "persona_switch") {
    const targetPersona = cleanString(value.target_persona);
    if (targetPersona !== "investor" && targetPersona !== "ria") return null;
    return {
      type,
      target_persona: targetPersona,
      confirmation_required: value.confirmation_required === true,
      reason: cleanString(value.reason) || undefined,
      preconditions,
      postconditions,
      failure_behavior: failureBehavior,
      settlement_target: settlementTarget,
    };
  }
  if (type === "tool_call") {
    const toolName = cleanString(value.tool_name);
    if (!toolName) return null;
    return {
      type,
      tool_name: toolName as VoiceToolCall["tool_name"],
      args: isPlainObject(value.args) ? value.args : undefined,
      confirmation_required: value.confirmation_required === true,
      reason: cleanString(value.reason) || undefined,
      preconditions,
      postconditions,
      failure_behavior: failureBehavior,
      settlement_target: settlementTarget,
    };
  }
  if (type === "prompt") {
    const message = cleanString(value.message);
    if (!message) return null;
    return {
      type,
      message,
      preconditions,
      postconditions,
      failure_behavior: failureBehavior,
      settlement_target: settlementTarget,
    };
  }
  return null;
}

function validateWorkflow(value: unknown): KaiActionWorkflow {
  if (!isPlainObject(value)) return null;
  const workflowId = cleanString(value.workflow_id);
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map((entry) => validateWorkflowStep(entry))
        .filter((entry): entry is KaiActionWorkflowStep => Boolean(entry))
    : [];
  if (!workflowId || steps.length === 0) return null;
  return {
    workflow_id: workflowId,
    confirmation_required: value.confirmation_required === true,
    failure_message: cleanString(value.failure_message),
    blocked_guidance: cleanString(value.blocked_guidance),
    steps,
  };
}

function validateGoalRequiredInput(
  value: unknown,
): KaiGoalRequiredInput | null {
  if (!isPlainObject(value)) return null;
  const name = cleanString(value.name);
  const prompt = cleanString(value.prompt);
  if (!name || !prompt) return null;
  const input: KaiGoalRequiredInput = {
    name,
    prompt,
    required: value.required !== false,
    slot: cleanString(value.slot) || undefined,
    resolver: cleanString(value.resolver) || undefined,
    default_value: cleanString(value.default_value) || undefined,
    options: isStringArray(value.options) ? value.options : undefined,
  };
  return input;
}

function validateGoalWorkflowStep(value: unknown): KaiGoalWorkflowStep | null {
  if (!isPlainObject(value)) return null;
  const type = cleanString(value.type);
  const label = cleanString(value.label);
  if (!type || !label) return null;
  return {
    type,
    label,
    action_id: cleanString(value.action_id) || undefined,
    service: cleanString(value.service) || undefined,
    slots: isPlainObject(value.slots) ? value.slots : undefined,
    failure_behavior:
      value.failure_behavior === "continue" ? "continue" : "stop",
    settlement_target: isPlainObject(value.settlement_target)
      ? {
          route: cleanString(value.settlement_target.route) || undefined,
          screen: cleanString(value.settlement_target.screen) || undefined,
          persona: cleanString(value.settlement_target.persona) || undefined,
        }
      : undefined,
  };
}

function validateGoal(value: unknown, actionId: string): KaiActionGoal {
  const fallback: KaiActionGoal = {
    goal_id: `goal.${actionId}`,
    required_inputs: [],
    input_resolvers: [],
    slot_schema: {},
    workflow_steps: [],
    progress_contract: {},
    cancellation_contract: { cancellable: false, cancel_action_id: null },
    result_contract: { summary_mode: "action_receipt" },
    entrypoint_support: ["voice", "chat", "typed_search", "command_bar", "ui"],
  };
  if (!isPlainObject(value)) return fallback;
  const goalId = cleanString(value.goal_id) || fallback.goal_id;
  const requiredInputs = Array.isArray(value.required_inputs)
    ? value.required_inputs
        .map((entry) => validateGoalRequiredInput(entry))
        .filter((entry): entry is KaiGoalRequiredInput => Boolean(entry))
    : [];
  const workflowSteps = Array.isArray(value.workflow_steps)
    ? value.workflow_steps
        .map((entry) => validateGoalWorkflowStep(entry))
        .filter((entry): entry is KaiGoalWorkflowStep => Boolean(entry))
    : [];
  return {
    goal_id: goalId,
    required_inputs: requiredInputs,
    input_resolvers: isStringArray(value.input_resolvers)
      ? value.input_resolvers
      : [],
    slot_schema: isPlainObject(value.slot_schema) ? value.slot_schema : {},
    workflow_steps: workflowSteps,
    progress_contract: isPlainObject(value.progress_contract)
      ? value.progress_contract
      : {},
    cancellation_contract: isPlainObject(value.cancellation_contract)
      ? value.cancellation_contract
      : fallback.cancellation_contract,
    result_contract: isPlainObject(value.result_contract)
      ? value.result_contract
      : fallback.result_contract,
    entrypoint_support: isStringArray(value.entrypoint_support)
      ? value.entrypoint_support
      : fallback.entrypoint_support,
  };
}

function validateExternalCallback(
  value: unknown,
): KaiActionExternalCallback | null {
  if (!isPlainObject(value)) return null;
  if (
    (value.provider !== "google" && value.provider !== "apple") ||
    value.starts !== "external_redirect_started" ||
    value.settlement !== "firebase_redirect_callback" ||
    value.failure_behavior !== "retain_goal_and_retry"
  ) {
    return null;
  }
  const returnTo = cleanString(value.return_to);
  return returnTo
    ? {
        provider: value.provider,
        starts: value.starts,
        settlement: value.settlement,
        failure_behavior: value.failure_behavior,
        return_to: returnTo,
      }
    : null;
}

function validateAction(value: unknown): KaiActionDefinition | null {
  if (!isPlainObject(value)) return null;
  const actionId = cleanString(value.action_id);
  const surfaceId = cleanString(value.surface_id);
  const label = cleanString(value.label);
  const meaning = cleanString(value.meaning);
  const riskLevel = cleanString(value.risk_level);
  const executionPolicy = cleanString(value.execution_policy);
  const activationPolicy = cleanString(value.activation_policy) || "none";
  if (
    !actionId ||
    !surfaceId ||
    !label ||
    !meaning ||
    !riskLevel ||
    !executionPolicy
  ) {
    return null;
  }
  if (
    activationPolicy !== "none" &&
    activationPolicy !== "trusted_activation_required"
  ) {
    return null;
  }
  if (!isPlainObject(value.reachability)) return null;
  if (
    !isStringArray(value.reachability.routes) ||
    !isStringArray(value.reachability.screens) ||
    !isStringArray(value.reachability.navigation_prerequisites)
  ) {
    return null;
  }
  const executionTarget = validateExecutionTarget(value.execution_target);
  if (!executionTarget) return null;

  return {
    action_id: actionId,
    surface_id: surfaceId,
    label,
    aliases: isStringArray(value.aliases) ? value.aliases : [],
    search_keywords: isStringArray(value.search_keywords)
      ? value.search_keywords
      : [],
    meaning,
    speaker_persona: validateSpeakerPersona(value.speaker_persona),
    delegate_agent_id: validateDelegateAgentId(value.delegate_agent_id),
    reachability: {
      routes: value.reachability.routes,
      screens: value.reachability.screens,
      hidden_navigable: value.reachability.hidden_navigable === true,
      navigation_prerequisites: value.reachability.navigation_prerequisites,
      active_personas: (isStringArray(value.reachability.active_personas)
        ? value.reachability.active_personas
        : []) as Persona[],
      requires_persona_switch_confirmation:
        value.reachability.requires_persona_switch_confirmation === true,
    },
    guard_ids: isStringArray(value.guard_ids) ? value.guard_ids : [],
    risk_level: riskLevel as KaiActionRiskLevel,
    execution_policy: executionPolicy as KaiActionExecutionPolicy,
    activation_policy: activationPolicy as KaiActionActivationPolicy,
    execution_target: executionTarget,
    control_ids: isStringArray(value.control_ids) ? value.control_ids : [],
    state_exposure: isStringArray(value.state_exposure)
      ? value.state_exposure
      : [],
    docs_references: isStringArray(value.docs_references)
      ? value.docs_references
      : [],
    workflow: validateWorkflow(value.workflow),
    external_callback: validateExternalCallback(value.external_callback),
    goal: validateGoal(value.goal, actionId),
    expected_effects: {
      state_changes:
        isPlainObject(value.expected_effects) &&
        isStringArray(value.expected_effects.state_changes)
          ? value.expected_effects.state_changes
          : [],
      backend_effects:
        isPlainObject(value.expected_effects) &&
        Array.isArray(value.expected_effects.backend_effects)
          ? value.expected_effects.backend_effects
              .map((entry) => {
                if (!isPlainObject(entry)) return null;
                const api = cleanString(entry.api);
                const effect = cleanString(entry.effect);
                if (!api || !effect) return null;
                return { api, effect };
              })
              .filter((entry): entry is { api: string; effect: string } =>
                Boolean(entry),
              )
          : [],
    },
    trigger:
      isPlainObject(value.trigger) &&
      cleanString(value.trigger.primary) &&
      isStringArray(value.trigger.supported)
        ? {
            primary: value.trigger
              .primary as KaiActionDefinition["trigger"]["primary"],
            supported: value.trigger
              .supported as KaiActionDefinition["trigger"]["supported"],
          }
        : {
            primary: "voice",
            supported: ["voice", "tap", "keyboard", "programmatic"],
          },
  };
}

function validateSurface(value: unknown): KaiActionSurfaceDefinition | null {
  if (!isPlainObject(value)) return null;
  const schemaVersion = cleanString(value.schema_version);
  const surfaceId = cleanString(value.surface_id);
  const surfaceTitle = cleanString(value.surface_title);
  const contractFile = cleanString(value.contract_file);
  if (!schemaVersion || !surfaceId || !surfaceTitle || !contractFile)
    return null;
  return {
    schema_version: schemaVersion,
    surface_id: surfaceId,
    surface_title: surfaceTitle,
    docs_references: isStringArray(value.docs_references)
      ? value.docs_references
      : [],
    contract_file: contractFile,
    defaults: isPlainObject(value.defaults) ? value.defaults : undefined,
  };
}

function validateGateway(value: unknown): KaiActionGateway {
  if (!isPlainObject(value)) {
    throw new Error("Kai action gateway payload must be a plain object.");
  }
  const schemaVersion = cleanString(value.schema_version);
  if (!schemaVersion) {
    throw new Error("Kai action gateway schema_version is required.");
  }
  const surfaces = Array.isArray(value.surfaces)
    ? value.surfaces
        .map((entry) => validateSurface(entry))
        .filter((entry): entry is KaiActionSurfaceDefinition => Boolean(entry))
    : [];
  const actions = Array.isArray(value.actions)
    ? value.actions
        .map((entry) => validateAction(entry))
        .filter((entry): entry is KaiActionDefinition => Boolean(entry))
    : [];
  return {
    schema_version: schemaVersion,
    generator: cleanString(value.generator) || undefined,
    generated_at: cleanString(value.generated_at) || undefined,
    source_contracts: isStringArray(value.source_contracts)
      ? value.source_contracts
      : undefined,
    surfaces,
    actions,
  };
}

export const KAI_ACTION_GATEWAY = validateGateway(gatewayJson);
export const KAI_ACTION_GATEWAY_ACTIONS = KAI_ACTION_GATEWAY.actions;

const KAI_ACTION_BY_ID = new Map(
  KAI_ACTION_GATEWAY_ACTIONS.map(
    (action) => [action.action_id, action] as const,
  ),
);

const KAI_ACTIONS_BY_CONTROL_ID = new Map<string, KaiActionDefinition[]>();
for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
  for (const controlId of action.control_ids) {
    const existing = KAI_ACTIONS_BY_CONTROL_ID.get(controlId) || [];
    existing.push(action);
    KAI_ACTIONS_BY_CONTROL_ID.set(controlId, existing);
  }
}

function toPathname(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  const queryIndex = normalized.indexOf("?");
  return queryIndex >= 0 ? normalized.slice(0, queryIndex) : normalized;
}

function routeMatchesSurface(
  routeHref: string,
  surfaceHref: string,
  surfacePathname: string,
): boolean {
  const normalizedRoute = String(routeHref || "").trim();
  if (!normalizedRoute) return false;
  if (normalizedRoute.includes("?")) {
    return Boolean(surfaceHref) && normalizedRoute === surfaceHref;
  }
  if (surfaceHref && normalizedRoute === surfaceHref) {
    return true;
  }
  return toPathname(normalizedRoute) === surfacePathname;
}

export function getKaiActionById(
  actionId: string | null | undefined,
): KaiActionDefinition | null {
  const normalized = String(actionId || "").trim();
  if (!normalized) return null;
  return KAI_ACTION_BY_ID.get(normalized) || null;
}

export function listKaiActions(): readonly KaiActionDefinition[] {
  return KAI_ACTION_GATEWAY_ACTIONS;
}

export function listKaiActionsForSurface(input: {
  screen?: string | null;
  href?: string | null;
  pathname?: string | null;
}): readonly KaiActionDefinition[] {
  const screen = cleanString(input.screen);
  const href = cleanString(input.href) || "";
  const pathname = toPathname(input.pathname || href);
  return KAI_ACTION_GATEWAY_ACTIONS.filter((action) => {
    if (screen && action.reachability.screens.includes(screen)) {
      return true;
    }
    return action.reachability.routes.some((routeHref) =>
      routeMatchesSurface(routeHref, href, pathname),
    );
  });
}

export function getKaiActionsForControlId(
  controlId: string | null | undefined,
): readonly KaiActionDefinition[] {
  const normalized = cleanString(controlId);
  if (!normalized) return [];
  return KAI_ACTIONS_BY_CONTROL_ID.get(normalized) || [];
}

export function getKaiActionByKaiCommand(
  command: KaiCommandAction,
): KaiActionDefinition | null {
  for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
    if (action.execution_target.status !== "wired") continue;
    if (action.execution_target.path !== "kai_command") continue;
    if (action.execution_target.target === command) return action;
  }
  return null;
}

function voiceToolParamsMatch(
  params: Record<string, unknown> | undefined,
  toolCall: VoiceToolCall,
): boolean {
  if (!params || Object.keys(params).length === 0) return true;
  const args = toolCall.args as Record<string, unknown>;
  return Object.entries(params).every(
    ([key, expected]) => args[key] === expected,
  );
}

function isWiredVoiceToolAction(
  action: KaiActionDefinition,
  toolName: VoiceToolCall["tool_name"],
): action is WiredKaiActionDefinition {
  return (
    action.execution_target.status === "wired" &&
    action.execution_target.path === "voice_tool" &&
    action.execution_target.target === toolName
  );
}

export function getKaiActionByVoiceToolCall(
  toolCall: VoiceToolCall,
): KaiActionDefinition | null {
  if (toolCall.tool_name === "execute_kai_command") {
    return getKaiActionByKaiCommand(toolCall.args.command);
  }
  const candidates = KAI_ACTION_GATEWAY_ACTIONS.filter((action) =>
    isWiredVoiceToolAction(action, toolCall.tool_name),
  );
  if (candidates.length === 0) {
    return null;
  }
  const paramMatches = candidates.filter((action) =>
    voiceToolParamsMatch(action.execution_target.params, toolCall),
  );
  if (paramMatches.length === 1) {
    return paramMatches[0] || null;
  }
  if (paramMatches.length > 1) {
    const unparameterized = paramMatches.filter(
      (action) =>
        action.execution_target.status === "wired" &&
        (!action.execution_target.params ||
          Object.keys(action.execution_target.params).length === 0),
    );
    return unparameterized.length === 1 ? unparameterized[0] || null : null;
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (!candidate || candidate.execution_target.status !== "wired") return null;
  return candidate.execution_target.params ? null : candidate;
}

function boolFromSurfaceMetadata(
  surfaceMetadata: VoiceSurfaceMetadata | undefined,
  key: string,
): boolean | undefined {
  const metadata = surfaceMetadata?.screenMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function evaluateKaiActionAvailability(input: {
  action: KaiActionDefinition;
  appRuntimeState?: AppRuntimeState;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  allowPersonaRouteSettlement?: boolean;
}): KaiActionAvailability {
  const { action, appRuntimeState, surfaceMetadata } = input;
  if (action.execution_policy === "manual_only") {
    return {
      status: "manual_only",
      reason: "This action remains manual in the current Kai workflow.",
      target_persona: null,
      blocked_guidance: action.workflow?.blocked_guidance || null,
    };
  }
  if (action.execution_target.status === "unwired") {
    return {
      status: "unwired",
      reason: action.execution_target.reason,
      target_persona: null,
      blocked_guidance: action.workflow?.blocked_guidance || null,
    };
  }

  const activePersona = appRuntimeState?.persona?.active || "investor";
  const availablePersonas = new Set<Persona>(
    (appRuntimeState?.persona?.available || [activePersona]) as Persona[],
  );
  const requiredPersonas = action.reachability.active_personas;
  if (
    requiredPersonas.length > 0 &&
    !requiredPersonas.includes(activePersona as Persona)
  ) {
    const targetPersona = requiredPersonas.find((persona) =>
      availablePersonas.has(persona),
    );
    if (targetPersona) {
      const canSettleInactivePersona =
        Boolean(input.allowPersonaRouteSettlement) &&
        action.execution_policy === "allow_direct" &&
        action.execution_target.status === "wired" &&
        action.reachability.requires_persona_switch_confirmation !== true;
      if (!canSettleInactivePersona) {
        return {
          status: "requires_persona_switch",
          reason: `Switch to ${targetPersona.toUpperCase()} workspace first.`,
          target_persona: targetPersona,
          blocked_guidance: action.workflow?.blocked_guidance || null,
        };
      }
    }
    if (!targetPersona) {
      return {
        status: "blocked",
        reason:
          requiredPersonas.includes("ria") &&
          appRuntimeState?.persona?.ria_setup_available
            ? "RIA actions stay locked until you finish RIA setup."
            : requiredPersonas.includes("investor")
              ? "Switch to the Investor workspace before using Kai finance actions."
              : "This action is not available in the active workspace.",
        target_persona: requiredPersonas[0] || null,
        blocked_guidance:
          action.workflow?.blocked_guidance ||
          (requiredPersonas.includes("ria") &&
          appRuntimeState?.persona?.ria_setup_available
            ? "Complete RIA setup to unlock this workspace."
            : requiredPersonas.includes("investor")
              ? "Switch to Investor to use this Kai finance action."
              : null),
      };
    }
  }

  for (const guardId of action.guard_ids) {
    if (
      (guardId === "auth_signed_in" || guardId === "auth_required") &&
      appRuntimeState?.auth.signed_in !== true
    ) {
      return {
        status: "blocked",
        reason: "Sign in to use this action.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "vault_unlocked" &&
      appRuntimeState?.vault.unlocked !== true
    ) {
      return {
        status: "blocked",
        reason: "Unlock to use this action.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "portfolio_required" &&
      appRuntimeState?.portfolio.has_portfolio_data !== true
    ) {
      return {
        status: "blocked",
        reason: "Import your portfolio first.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "analysis_idle_required" &&
      appRuntimeState?.runtime.analysis_active === true
    ) {
      return {
        status: "blocked",
        reason: "Wait for the active analysis to finish first.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "active_analysis_required" &&
      appRuntimeState?.runtime.analysis_active !== true
    ) {
      return {
        status: "blocked",
        reason: "There is no active analysis to act on.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "gmail_connected" &&
      boolFromSurfaceMetadata(
        surfaceMetadata || undefined,
        "gmail_connected",
      ) === false
    ) {
      return {
        status: "blocked",
        reason: "Connect Gmail first.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "gmail_configured" &&
      boolFromSurfaceMetadata(
        surfaceMetadata || undefined,
        "gmail_configured",
      ) === false
    ) {
      return {
        status: "blocked",
        reason: "Gmail configuration is not ready yet.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (guardId === "ria_persona_available" && !availablePersonas.has("ria")) {
      return {
        status: "blocked",
        reason: "RIA workspace is not available for this account yet.",
        target_persona: "ria",
        blocked_guidance:
          appRuntimeState?.persona?.ria_setup_available === true
            ? "Complete RIA setup to unlock the workspace."
            : null,
      };
    }
  }

  return {
    status: "available",
    reason: null,
    target_persona: null,
    blocked_guidance: null,
  };
}

function scoreSearchMatch(
  action: KaiActionDefinition,
  query: string,
  screen: string | null,
): number {
  const q = query.trim().toLowerCase();
  let score = 0;
  if (!q) {
    if (screen && action.reachability.screens.includes(screen)) score += 4;
    if (!action.reachability.hidden_navigable) score += 2;
    return score;
  }
  if (action.label.toLowerCase().includes(q)) score += 8;
  if (action.action_id.toLowerCase().includes(q)) score += 6;
  if (action.aliases.some((alias) => alias.toLowerCase().includes(q)))
    score += 5;
  if (
    action.search_keywords.some((keyword) => keyword.toLowerCase().includes(q))
  )
    score += 4;
  if (action.meaning.toLowerCase().includes(q)) score += 3;
  if (screen && action.reachability.screens.includes(screen)) score += 2;
  return score;
}

function availabilitySearchRank(availability: KaiActionAvailability): number {
  if (
    availability.status === "available" ||
    availability.status === "requires_persona_switch"
  ) {
    return 0;
  }
  return 1;
}

export function searchKaiActions(input: {
  query: string;
  appRuntimeState?: AppRuntimeState;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  limit?: number;
}): Array<{
  action: KaiActionDefinition;
  availability: KaiActionAvailability;
  score: number;
}> {
  const screen = cleanString(input.appRuntimeState?.route.screen) || null;
  const limit = Math.max(1, Math.min(input.limit ?? 12, 40));
  return KAI_ACTION_GATEWAY_ACTIONS.map((action) => ({
    action,
    availability: evaluateKaiActionAvailability({
      action,
      appRuntimeState: input.appRuntimeState,
      surfaceMetadata: input.surfaceMetadata,
    }),
    score: scoreSearchMatch(action, input.query, screen),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const availabilityRank =
        availabilitySearchRank(a.availability) -
        availabilitySearchRank(b.availability);
      if (availabilityRank !== 0) return availabilityRank;
      if (b.score !== a.score) return b.score - a.score;
      return a.action.label.localeCompare(b.action.label);
    })
    .slice(0, limit);
}
