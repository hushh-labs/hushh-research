#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WEBAPP_ROOT = path.resolve(REPO_ROOT, "hushh-webapp");
const CONTRACT_SUFFIX = ".voice-action-contract.json";
const GATEWAY_OUTPUT_PATH = path.resolve(REPO_ROOT, "contracts/kai/kai-action-gateway.vnext.json");
const MANIFEST_OUTPUT_PATH = path.resolve(REPO_ROOT, "contracts/kai/voice-action-manifest.v1.json");
const WEBAPP_GATEWAY_OUTPUT_PATH = path.resolve(
  WEBAPP_ROOT,
  "contracts/kai/kai-action-gateway.vnext.json"
);
const WEBAPP_MANIFEST_OUTPUT_PATH = path.resolve(
  WEBAPP_ROOT,
  "contracts/kai/voice-action-manifest.v1.json"
);

const SPEAKER_PERSONAS = new Set(["one", "kai", "nav", "kyc"]);
const AGENT_PERSONAS = new Set([
  "one",
  "kai",
  "nav",
  "agent_kyc",
  "agent_nav",
  "agent_connected_systems",
  "agent_connections",
  "agent_email",
  "agent_gmail",
  "agent_location",
  "agent_personal_information",
]);
const DEFAULT_TRIGGER = {
  primary: "voice",
  supported: ["voice", "tap", "keyboard", "programmatic"],
};

function toRelativeRepoPath(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).replaceAll(path.sep, "/");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => cleanString(value))
        .filter((value) => Boolean(value))
    )
  );
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSettlementTarget(raw) {
  if (!isPlainObject(raw)) return null;
  const target = {};
  const route = cleanString(raw.route);
  if (route) target.route = route;
  const screen = cleanString(raw.screen);
  if (screen) target.screen = screen;
  const persona = cleanString(raw.persona);
  if (persona) target.persona = persona;
  return Object.keys(target).length > 0 ? target : null;
}

function normalizeWorkflowStep(step, actionId) {
  if (!isPlainObject(step)) {
    throw new Error(`${actionId}: workflow step must be an object`);
  }
  const type = cleanString(step.type);
  if (!type) {
    throw new Error(`${actionId}: workflow step type is required`);
  }

  const normalized = {
    type,
    preconditions: uniqueStrings(step.preconditions),
    postconditions: uniqueStrings(step.postconditions),
    failure_behavior: cleanString(step.failure_behavior) || "stop",
  };

  const settlementTarget = normalizeSettlementTarget(step.settlement_target);
  if (settlementTarget) {
    normalized.settlement_target = settlementTarget;
  }

  if (type === "route_switch") {
    const href = cleanString(step.href);
    if (!href) {
      throw new Error(`${actionId}: route_switch step requires href`);
    }
    normalized.href = href;
    return normalized;
  }

  if (type === "persona_switch") {
    const targetPersona = cleanString(step.target_persona);
    if (!targetPersona) {
      throw new Error(`${actionId}: persona_switch step requires target_persona`);
    }
    normalized.target_persona = targetPersona;
    if (typeof step.confirmation_required === "boolean") {
      normalized.confirmation_required = step.confirmation_required;
    }
    if (typeof step.reason === "string") {
      normalized.reason = step.reason.trim();
    }
    return normalized;
  }

  if (type === "tool_call") {
    const toolName = cleanString(step.tool_name);
    if (!toolName) {
      throw new Error(`${actionId}: tool_call step requires tool_name`);
    }
    normalized.tool_name = toolName;
    if (isPlainObject(step.args)) {
      normalized.args = step.args;
    }
    if (typeof step.confirmation_required === "boolean") {
      normalized.confirmation_required = step.confirmation_required;
    }
    if (typeof step.reason === "string") {
      normalized.reason = step.reason.trim();
    }
    return normalized;
  }

  if (type === "prompt") {
    const message = cleanString(step.message);
    if (!message) {
      throw new Error(`${actionId}: prompt step requires message`);
    }
    normalized.message = message;
    return normalized;
  }

  throw new Error(`${actionId}: unsupported workflow step type "${type}"`);
}

function normalizeWorkflow(raw, actionId) {
  if (!isPlainObject(raw)) return null;
  const workflowId = cleanString(raw.workflow_id);
  const steps = ensureArray(raw.steps).map((step) => normalizeWorkflowStep(step, actionId));
  if (!workflowId || steps.length === 0) {
    throw new Error(`${actionId}: workflow requires workflow_id and at least one step`);
  }
  return {
    workflow_id: workflowId,
    confirmation_required: raw.confirmation_required === true,
    failure_message: cleanString(raw.failure_message),
    blocked_guidance: cleanString(raw.blocked_guidance),
    steps,
  };
}

function normalizeGoalInput(raw, actionId) {
  if (!isPlainObject(raw)) {
    throw new Error(`${actionId}: goal required input must be an object`);
  }
  const name = cleanString(raw.name);
  const prompt = cleanString(raw.prompt);
  if (!name || !prompt) {
    throw new Error(`${actionId}: goal required input requires name and prompt`);
  }
  const normalized = {
    name,
    prompt,
    required: raw.required !== false,
  };
  const slot = cleanString(raw.slot);
  if (slot) normalized.slot = slot;
  const resolver = cleanString(raw.resolver);
  if (resolver) normalized.resolver = resolver;
  const defaultValue = cleanString(raw.default_value);
  if (defaultValue) normalized.default_value = defaultValue;
  const options = uniqueStrings(raw.options);
  if (options.length > 0) normalized.options = options;
  return normalized;
}

function normalizeGoalStep(raw, actionId) {
  if (!isPlainObject(raw)) {
    throw new Error(`${actionId}: goal workflow step must be an object`);
  }
  const type = cleanString(raw.type);
  if (!type) {
    throw new Error(`${actionId}: goal workflow step type is required`);
  }
  const normalized = {
    type,
    label: cleanString(raw.label) || type,
    failure_behavior: cleanString(raw.failure_behavior) || "stop",
  };
  const actionRef = cleanString(raw.action_id);
  if (actionRef) normalized.action_id = actionRef;
  const service = cleanString(raw.service);
  if (service) normalized.service = service;
  if (isPlainObject(raw.slots)) normalized.slots = raw.slots;
  const settlementTarget = normalizeSettlementTarget(raw.settlement_target);
  if (settlementTarget) normalized.settlement_target = settlementTarget;
  return normalized;
}

function inferGoalRequiredInputs(action) {
  if (
    action.action_id === "analysis.start" ||
    (action.execution_target.status === "wired" &&
      action.execution_target.path === "kai_command" &&
      action.execution_target.target === "analyze")
  ) {
    return [
      {
        name: "ticker",
        slot: "symbol",
        resolver: "ticker_symbol",
        prompt: "Which stock should I analyze?",
        required: true,
      },
      {
        name: "pick_source",
        slot: "pickSource",
        resolver: "kai_pick_source",
        prompt: "Which list should Kai use for this debate?",
        required: true,
        default_value: "default",
        options: ["default"],
      },
    ];
  }
  return [];
}

function createDefaultGoalWorkflowSteps(action) {
  if (action.action_id === "analysis.start") {
    return [
      {
        type: "action",
        action_id: "analysis.start",
        label: "Prepare stock analysis",
        failure_behavior: "stop",
        settlement_target: {
          route: "/one/kai/analysis",
          screen: "kai_analysis",
        },
      },
      {
        type: "service",
        service: "kai_debate.ensure_run",
        label: "Run Kai debate",
        failure_behavior: "stop",
        settlement_target: {
          route: "/one/kai/analysis",
          screen: "kai_analysis_workspace",
        },
      },
    ];
  }
  return [
    {
      type: "action",
      action_id: action.action_id,
      label: action.label,
      failure_behavior: "stop",
      settlement_target:
        action.execution_target.status === "wired" && action.execution_target.path === "route"
          ? {
              route: action.execution_target.target,
              screen: action.reachability.screens[0],
            }
          : {
              route: action.reachability.routes[0],
              screen: action.reachability.screens[0],
            },
    },
  ];
}

function normalizeGoal(raw, action) {
  const explicit = isPlainObject(raw) ? raw : {};
  const goalId = cleanString(explicit.goal_id) || `goal.${action.action_id}`;
  const requiredInputs =
    ensureArray(explicit.required_inputs).length > 0
      ? ensureArray(explicit.required_inputs).map((input) =>
          normalizeGoalInput(input, action.action_id)
        )
      : inferGoalRequiredInputs(action);
  const workflowSteps =
    ensureArray(explicit.workflow_steps).length > 0
      ? ensureArray(explicit.workflow_steps).map((step) => normalizeGoalStep(step, action.action_id))
      : createDefaultGoalWorkflowSteps(action);
  return {
    goal_id: goalId,
    required_inputs: requiredInputs,
    input_resolvers: uniqueStrings(explicit.input_resolvers),
    slot_schema: isPlainObject(explicit.slot_schema) ? explicit.slot_schema : {},
    workflow_steps: workflowSteps,
    progress_contract: isPlainObject(explicit.progress_contract)
      ? explicit.progress_contract
      : {
          mode: action.action_id === "analysis.start" ? "milestone" : "none",
          milestone_events:
            action.action_id === "analysis.start"
              ? ["started", "agent_complete", "decision"]
              : [],
        },
    cancellation_contract: isPlainObject(explicit.cancellation_contract)
      ? explicit.cancellation_contract
      : {
          cancellable: action.action_id === "analysis.start" || action.action_id === "analysis.cancel_active",
          cancel_action_id:
            action.action_id === "analysis.start" ? "analysis.cancel_active" : null,
        },
    result_contract: isPlainObject(explicit.result_contract)
      ? explicit.result_contract
      : {
          summary_mode: action.action_id === "analysis.start" ? "decision_summary" : "action_result",
        },
    entrypoint_support: uniqueStrings(explicit.entrypoint_support).length
      ? uniqueStrings(explicit.entrypoint_support)
      : ["voice", "chat", "typed_search", "command_bar", "ui"],
  };
}

function normalizeExecutionTarget(raw, actionId) {
  if (!isPlainObject(raw)) {
    throw new Error(`${actionId}: execution_target must be an object`);
  }
  const status = cleanString(raw.status);
  if (!status) {
    throw new Error(`${actionId}: execution_target.status is required`);
  }

  if (status === "wired") {
    const pathValue = cleanString(raw.path);
    const target = cleanString(raw.target);
    if (!pathValue || !target) {
      throw new Error(`${actionId}: wired execution_target requires path and target`);
    }
    const normalized = {
      status,
      path: pathValue,
      target,
    };
    if (isPlainObject(raw.params)) {
      normalized.params = raw.params;
    }
    return normalized;
  }

  if (status === "unwired") {
    const reason = cleanString(raw.reason);
    if (!reason) {
      throw new Error(`${actionId}: unwired execution_target requires reason`);
    }
    const normalized = {
      status,
      reason,
    };
    const intendedHandler = cleanString(raw.intended_handler);
    if (intendedHandler) {
      normalized.intended_handler = intendedHandler;
    }
    return normalized;
  }

  if (status === "dead") {
    const reason = cleanString(raw.reason);
    if (!reason) {
      throw new Error(`${actionId}: dead execution_target requires reason`);
    }
    return {
      status,
      reason,
    };
  }

  throw new Error(`${actionId}: unsupported execution_target.status "${status}"`);
}

function normalizeReachability(raw, defaults, actionId) {
  const merged = {
    ...(isPlainObject(defaults) ? defaults : {}),
    ...(isPlainObject(raw) ? raw : {}),
  };
  const routes = uniqueStrings(merged.routes);
  const screens = uniqueStrings(merged.screens);
  if (routes.length === 0) {
    throw new Error(`${actionId}: reachability.routes must contain at least one route`);
  }
  if (screens.length === 0) {
    throw new Error(`${actionId}: reachability.screens must contain at least one screen`);
  }
  return {
    routes,
    screens,
    hidden_navigable: merged.hidden_navigable === true,
    navigation_prerequisites: uniqueStrings(merged.navigation_prerequisites),
    active_personas: uniqueStrings(merged.active_personas),
    requires_persona_switch_confirmation:
      merged.requires_persona_switch_confirmation === true,
  };
}

function normalizeExpectedEffects(raw) {
  if (!isPlainObject(raw)) {
    return {
      state_changes: [],
      backend_effects: [],
    };
  }
  return {
    state_changes: uniqueStrings(raw.state_changes),
    backend_effects: ensureArray(raw.backend_effects)
      .map((entry) => {
        if (!isPlainObject(entry)) return null;
        const api = cleanString(entry.api);
        const effect = cleanString(entry.effect);
        if (!api || !effect) return null;
        return { api, effect };
      })
      .filter((entry) => Boolean(entry)),
  };
}

function deriveDefaultStateChanges(action) {
  if (action.expected_effects.state_changes.length > 0) {
    return action.expected_effects.state_changes;
  }
  if (action.execution_target.status === "wired" && action.execution_target.path === "route") {
    return [`current route becomes ${action.execution_target.target}`];
  }
  if (action.reachability.routes.length > 0) {
    return [`current route becomes ${action.reachability.routes[0]}`];
  }
  return ["Kai action state changes"];
}

function normalizeAction(surface, action) {
  if (!isPlainObject(action)) {
    throw new Error(`${surface.surface_id}: action entries must be objects`);
  }

  const actionId = cleanString(action.action_id);
  const label = cleanString(action.label);
  const meaning = cleanString(action.meaning);
  const riskLevel = cleanString(action.risk_level);
  const executionPolicy = cleanString(action.execution_policy);
  if (!actionId || !label || !meaning || !riskLevel || !executionPolicy) {
    throw new Error(
      `${surface.surface_id}: action requires action_id, label, meaning, risk_level, execution_policy`
    );
  }
  const speakerPersona =
    cleanString(action.speaker_persona) ||
    cleanString(surface.defaults?.speaker_persona) ||
    "one";
  if (!SPEAKER_PERSONAS.has(speakerPersona)) {
    throw new Error(
      `${actionId}: speaker_persona must be one of ${Array.from(SPEAKER_PERSONAS).join(", ")}`
    );
  }
  const delegateAgentId =
    cleanString(action.delegate_agent_id) || cleanString(surface.defaults?.delegate_agent_id);
  if (delegateAgentId && !AGENT_PERSONAS.has(delegateAgentId)) {
    throw new Error(
      `${actionId}: delegate_agent_id must be one of ${Array.from(AGENT_PERSONAS).join(", ")}`
    );
  }

  const docsReferences = uniqueStrings([
    ...surface.docs_references,
    ...uniqueStrings(action.docs_references),
  ]);
  const normalized = {
    action_id: actionId,
    surface_id: surface.surface_id,
    label,
    aliases: uniqueStrings(action.aliases),
    search_keywords: uniqueStrings(action.search_keywords),
    meaning,
    speaker_persona: speakerPersona,
    delegate_agent_id: delegateAgentId || null,
    reachability: normalizeReachability(action.reachability, surface.defaults?.reachability, actionId),
    guard_ids: uniqueStrings(action.guard_ids),
    risk_level: riskLevel,
    execution_policy: executionPolicy,
    execution_target: normalizeExecutionTarget(action.execution_target, actionId),
    control_ids: uniqueStrings(action.control_ids),
    state_exposure: uniqueStrings(action.state_exposure),
    docs_references: docsReferences,
    workflow: normalizeWorkflow(action.workflow, actionId),
    expected_effects: normalizeExpectedEffects(action.expected_effects),
    trigger: DEFAULT_TRIGGER,
  };

  normalized.goal = normalizeGoal(action.goal, normalized);
  normalized.expected_effects.state_changes = deriveDefaultStateChanges(normalized);
  return normalized;
}

function normalizeSurface(contractPath, raw) {
  if (!isPlainObject(raw)) {
    throw new Error(`${toRelativeRepoPath(contractPath)}: contract must be an object`);
  }
  const surfaceId = cleanString(raw.surface_id);
  const surfaceTitle = cleanString(raw.surface_title);
  if (!surfaceId || !surfaceTitle) {
    throw new Error(`${toRelativeRepoPath(contractPath)}: surface_id and surface_title are required`);
  }
  const docsReferences = uniqueStrings(raw.docs_references);
  const defaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const orchestrationRaw = isPlainObject(raw.orchestration) ? raw.orchestration : {};
  const contextPolicy = cleanString(orchestrationRaw.context_policy);
  const trustBoundary = cleanString(orchestrationRaw.trust_boundary);
  const delegationPolicy = cleanString(orchestrationRaw.delegation_policy);
  if (contextPolicy && !["publish", "minimal", "suppress"].includes(contextPolicy)) {
    throw new Error(`${toRelativeRepoPath(contractPath)}: invalid orchestration.context_policy`);
  }
  if (trustBoundary && !["none", "auth", "vault", "consent", "external_callback"].includes(trustBoundary)) {
    throw new Error(`${toRelativeRepoPath(contractPath)}: invalid orchestration.trust_boundary`);
  }
  if (delegationPolicy && !["one_action_gate", "no_delegation"].includes(delegationPolicy)) {
    throw new Error(`${toRelativeRepoPath(contractPath)}: invalid orchestration.delegation_policy`);
  }
  const surface = {
    schema_version: cleanString(raw.schema_version) || "kai.local_action_contract.v1",
    surface_id: surfaceId,
    surface_title: surfaceTitle,
    docs_references: docsReferences,
    contract_file: toRelativeRepoPath(contractPath),
    defaults,
    orchestration: {
      instruction_id: cleanString(orchestrationRaw.instruction_id),
      context_policy: contextPolicy,
      trust_boundary: trustBoundary,
      delegation_policy: delegationPolicy,
    },
  };
  const actions = ensureArray(raw.actions).map((action) => normalizeAction(surface, action));
  if (actions.length === 0) {
    throw new Error(`${surface.contract_file}: actions must contain at least one entry`);
  }
  return {
    surface,
    actions,
  };
}

async function listContractFiles(startDir) {
  const entries = await fs.readdir(startDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
      continue;
    }
    const absolutePath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listContractFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(CONTRACT_SUFFIX)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function toLegacyManifestAction(action) {
  return {
    id: action.action_id,
    label: action.label,
    meaning: action.meaning,
    speaker_persona: action.speaker_persona,
    delegate_agent_id: action.delegate_agent_id,
    aliases: action.aliases,
    scope: {
      routes: action.reachability.routes,
      screens: action.reachability.screens,
      hidden_navigable: action.reachability.hidden_navigable,
      navigation_prerequisites: action.reachability.navigation_prerequisites,
    },
    guard_ids: action.guard_ids,
    risk_level: action.risk_level,
    execution_policy: action.execution_policy,
    execution_hint: action.execution_target,
    goal: action.goal,
    map_references: action.docs_references,
  };
}

async function readContracts() {
  const contractFiles = (await listContractFiles(WEBAPP_ROOT)).sort();
  if (contractFiles.length === 0) {
    throw new Error(`No ${CONTRACT_SUFFIX} files found under hushh-webapp`);
  }

  const surfaces = [];
  const actions = [];
  const seenActionIds = new Map();

  for (const contractPath of contractFiles) {
    const raw = JSON.parse(await fs.readFile(contractPath, "utf8"));
    const normalized = normalizeSurface(contractPath, raw);
    surfaces.push(normalized.surface);
    for (const action of normalized.actions) {
      if (seenActionIds.has(action.action_id)) {
        throw new Error(
          `Duplicate action_id "${action.action_id}" in ${normalized.surface.contract_file} and ${seenActionIds.get(
            action.action_id
          )}`
        );
      }
      seenActionIds.set(action.action_id, normalized.surface.contract_file);
      actions.push(action);
    }
  }

  return {
    surfaces,
    actions,
    contractFiles,
  };
}

function createGatewayPayload(contracts) {
  return {
    schema_version: "kai.action_gateway.vnext",
    generator: "hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs",
    source_contracts: contracts.contractFiles.map((file) => toRelativeRepoPath(file)),
    surfaces: contracts.surfaces,
    actions: contracts.actions,
  };
}

function createLegacyManifestPayload(contracts) {
  return {
    schema_version: "kai.voice_action_manifest.v1",
    source_registry: "generated from colocated One Voice/Kai compatibility action contracts",
    source_gateway: "contracts/kai/kai-action-gateway.vnext.json",
    actions: contracts.actions.map((action) => toLegacyManifestAction(action)),
  };
}

async function writeIfChanged(targetPath, nextText, checkOnly) {
  let currentText = null;
  try {
    currentText = await fs.readFile(targetPath, "utf8");
  } catch {
    currentText = null;
  }

  if (currentText === nextText) {
    return { changed: false };
  }

  if (checkOnly) {
    return { changed: true };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextText, "utf8");
  return { changed: true };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");

  const contracts = await readContracts();
  const gatewayPayload = createGatewayPayload(contracts);
  const legacyManifestPayload = createLegacyManifestPayload(contracts);

  const gatewayText = `${JSON.stringify(gatewayPayload, null, 2)}\n`;
  const manifestText = `${JSON.stringify(legacyManifestPayload, null, 2)}\n`;

  const outputResults = await Promise.all([
    writeIfChanged(GATEWAY_OUTPUT_PATH, gatewayText, checkOnly),
    writeIfChanged(MANIFEST_OUTPUT_PATH, manifestText, checkOnly),
    writeIfChanged(WEBAPP_GATEWAY_OUTPUT_PATH, gatewayText, checkOnly),
    writeIfChanged(WEBAPP_MANIFEST_OUTPUT_PATH, manifestText, checkOnly),
  ]);

  if (checkOnly) {
    if (outputResults.some((result) => result.changed)) {
      throw new Error(
        "Kai action gateway artifacts are out of date. Run `npm run build:voice-gateway` from hushh-webapp."
      );
    }
    console.info("Kai action gateway artifacts are up to date.");
    return;
  }

  console.info(
    `Wrote Kai action gateway (${contracts.actions.length} actions across ${contracts.surfaces.length} surfaces).`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
