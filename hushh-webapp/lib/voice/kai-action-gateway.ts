import gatewayJson from "@/contracts/kai/kai-action-gateway.vnext.json";

import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import type { Persona } from "@/lib/services/ria-service";
import type { AppRuntimeState, VoiceToolCall } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export type KaiActionRiskLevel = "low" | "medium" | "high";
export type KaiActionExecutionPolicy = "allow_direct" | "confirm_required" | "manual_only";
export type KaiActionExecutionTarget =
  | {
      status: "wired";
      path: "kai_command" | "voice_tool" | "route";
      target: string;
      params?: Record<string, unknown>;
    }
  | {
      status: "unwired";
      reason: string;
      intended_handler?: string;
    }
  | {
      status: "dead";
      reason: string;
    };

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

export type KaiActionDefinition = {
  action_id: string;
  surface_id: string;
  label: string;
  aliases: string[];
  search_keywords: string[];
  meaning: string;
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
  execution_target: KaiActionExecutionTarget;
  control_ids: string[];
  state_exposure: string[];
  docs_references: string[];
  workflow: KaiActionWorkflow;
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
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateExecutionTarget(value: unknown): KaiActionExecutionTarget | null {
  if (!isPlainObject(value)) return null;
  const status = cleanString(value.status);
  if (status === "wired") {
    const path = cleanString(value.path);
    const target = cleanString(value.target);
    if (
      (path !== "kai_command" && path !== "voice_tool" && path !== "route") ||
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
  if (status === "dead") {
    const reason = cleanString(value.reason);
    if (!reason) return null;
    return { status, reason };
  }
  return null;
}

function validateWorkflowStep(value: unknown): KaiActionWorkflowStep | null {
  if (!isPlainObject(value)) return null;
  const type = cleanString(value.type);
  if (!type) return null;
  const preconditions = isStringArray(value.preconditions) ? value.preconditions : [];
  const postconditions = isStringArray(value.postconditions) ? value.postconditions : [];
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

function validateAction(value: unknown): KaiActionDefinition | null {
  if (!isPlainObject(value)) return null;
  const actionId = cleanString(value.action_id);
  const surfaceId = cleanString(value.surface_id);
  const label = cleanString(value.label);
  const meaning = cleanString(value.meaning);
  const riskLevel = cleanString(value.risk_level);
  const executionPolicy = cleanString(value.execution_policy);
  if (!actionId || !surfaceId || !label || !meaning || !riskLevel || !executionPolicy) {
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
    search_keywords: isStringArray(value.search_keywords) ? value.search_keywords : [],
    meaning,
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
    execution_target: executionTarget,
    control_ids: isStringArray(value.control_ids) ? value.control_ids : [],
    state_exposure: isStringArray(value.state_exposure) ? value.state_exposure : [],
    docs_references: isStringArray(value.docs_references) ? value.docs_references : [],
    workflow: validateWorkflow(value.workflow),
    expected_effects: {
      state_changes:
        isPlainObject(value.expected_effects) && isStringArray(value.expected_effects.state_changes)
          ? value.expected_effects.state_changes
          : [],
      backend_effects:
        isPlainObject(value.expected_effects) && Array.isArray(value.expected_effects.backend_effects)
          ? value.expected_effects.backend_effects
              .map((entry) => {
                if (!isPlainObject(entry)) return null;
                const api = cleanString(entry.api);
                const effect = cleanString(entry.effect);
                if (!api || !effect) return null;
                return { api, effect };
              })
              .filter(
                (entry): entry is { api: string; effect: string } => Boolean(entry)
              )
          : [],
    },
    trigger:
      isPlainObject(value.trigger) &&
      cleanString(value.trigger.primary) &&
      isStringArray(value.trigger.supported)
        ? {
            primary: value.trigger.primary as KaiActionDefinition["trigger"]["primary"],
            supported:
              value.trigger.supported as KaiActionDefinition["trigger"]["supported"],
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
  if (!schemaVersion || !surfaceId || !surfaceTitle || !contractFile) return null;
  return {
    schema_version: schemaVersion,
    surface_id: surfaceId,
    surface_title: surfaceTitle,
    docs_references: isStringArray(value.docs_references) ? value.docs_references : [],
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
    source_contracts: isStringArray(value.source_contracts) ? value.source_contracts : undefined,
    surfaces,
    actions,
  };
}

export const KAI_ACTION_GATEWAY = validateGateway(gatewayJson);
export const KAI_ACTION_GATEWAY_ACTIONS = KAI_ACTION_GATEWAY.actions;

const KAI_ACTION_BY_ID = new Map(
  KAI_ACTION_GATEWAY_ACTIONS.map((action) => [action.action_id, action] as const)
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

function routeMatchesSurface(routeHref: string, surfaceHref: string, surfacePathname: string): boolean {
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

export function getKaiActionById(actionId: string | null | undefined): KaiActionDefinition | null {
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
      routeMatchesSurface(routeHref, href, pathname)
    );
  });
}

export function getKaiActionsForControlId(controlId: string | null | undefined): readonly KaiActionDefinition[] {
  const normalized = cleanString(controlId);
  if (!normalized) return [];
  return KAI_ACTIONS_BY_CONTROL_ID.get(normalized) || [];
}

export function getKaiActionByKaiCommand(
  command: KaiCommandAction
): KaiActionDefinition | null {
  for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
    if (action.execution_target.status !== "wired") continue;
    if (action.execution_target.path !== "kai_command") continue;
    if (action.execution_target.target === command) return action;
  }
  return null;
}

export function getKaiActionByVoiceToolCall(toolCall: VoiceToolCall): KaiActionDefinition | null {
  if (toolCall.tool_name === "execute_kai_command") {
    return getKaiActionByKaiCommand(toolCall.args.command);
  }
  for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
    if (action.execution_target.status !== "wired") continue;
    if (action.execution_target.path !== "voice_tool") continue;
    if (action.execution_target.target === toolCall.tool_name) return action;
  }
  return null;
}

function boolFromSurfaceMetadata(
  surfaceMetadata: VoiceSurfaceMetadata | undefined,
  key: string
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
}): KaiActionAvailability {
  const { action, appRuntimeState, surfaceMetadata } = input;
  if (action.execution_target.status === "dead") {
    return {
      status: "dead",
      reason: action.execution_target.reason,
      target_persona: null,
      blocked_guidance: action.workflow?.blocked_guidance || null,
    };
  }
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
    (appRuntimeState?.persona?.available || [activePersona]) as Persona[]
  );
  const requiredPersonas = action.reachability.active_personas;
  if (requiredPersonas.length > 0 && !requiredPersonas.includes(activePersona as Persona)) {
    const targetPersona = requiredPersonas.find((persona) => availablePersonas.has(persona));
    if (targetPersona) {
      return {
        status: "requires_persona_switch",
        reason: `Switch to ${targetPersona.toUpperCase()} workspace first.`,
        target_persona: targetPersona,
        blocked_guidance: action.workflow?.blocked_guidance || null,
      };
    }
    return {
      status: "blocked",
      reason:
        requiredPersonas.includes("ria") && appRuntimeState?.persona?.ria_setup_available
          ? "RIA actions stay locked until you finish RIA setup."
          : "This action is not unlocked in the active Kai workspace.",
      target_persona: requiredPersonas[0] || null,
      blocked_guidance:
        action.workflow?.blocked_guidance ||
        (requiredPersonas.includes("ria") && appRuntimeState?.persona?.ria_setup_available
          ? "Complete RIA setup to unlock this workspace."
          : null),
    };
  }

  for (const guardId of action.guard_ids) {
    if (guardId === "auth_signed_in" && appRuntimeState?.auth.signed_in !== true) {
      return {
        status: "blocked",
        reason: "Sign in to use this action.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (guardId === "vault_unlocked" && appRuntimeState?.vault.unlocked !== true) {
      return {
        status: "blocked",
        reason: "Unlock the vault to use this action.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (guardId === "portfolio_required" && appRuntimeState?.portfolio.has_portfolio_data !== true) {
      return {
        status: "blocked",
        reason: "Import your portfolio first.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (guardId === "analysis_idle_required" && appRuntimeState?.runtime.analysis_active === true) {
      return {
        status: "blocked",
        reason: "Wait for the active analysis to finish first.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (guardId === "active_analysis_required" && appRuntimeState?.runtime.analysis_active !== true) {
      return {
        status: "blocked",
        reason: "There is no active analysis to act on.",
        target_persona: null,
        blocked_guidance: null,
      };
    }
    if (
      guardId === "gmail_connected" &&
      boolFromSurfaceMetadata(surfaceMetadata || undefined, "gmail_connected") === false
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
      boolFromSurfaceMetadata(surfaceMetadata || undefined, "gmail_configured") === false
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

function scoreSearchMatch(action: KaiActionDefinition, query: string, screen: string | null): number {
  const q = query.trim().toLowerCase();
  let score = 0;
  if (!q) {
    if (screen && action.reachability.screens.includes(screen)) score += 4;
    if (!action.reachability.hidden_navigable) score += 2;
    return score;
  }
  if (action.label.toLowerCase().includes(q)) score += 8;
  if (action.action_id.toLowerCase().includes(q)) score += 6;
  if (action.aliases.some((alias) => alias.toLowerCase().includes(q))) score += 5;
  if (action.search_keywords.some((keyword) => keyword.toLowerCase().includes(q))) score += 4;
  if (action.meaning.toLowerCase().includes(q)) score += 3;
  if (screen && action.reachability.screens.includes(screen)) score += 2;
  return score;
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
      if (b.score !== a.score) return b.score - a.score;
      return a.action.label.localeCompare(b.action.label);
    })
    .slice(0, limit);
}
