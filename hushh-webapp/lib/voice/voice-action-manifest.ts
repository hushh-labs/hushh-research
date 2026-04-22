import manifestJson from "../../../contracts/kai/voice-action-manifest.v1.json";

export type VoiceActionManifestRiskLevel = "low" | "medium" | "high";
export type VoiceActionManifestExecutionPolicy = "allow_direct" | "confirm_required" | "manual_only";
export type VoiceActionManifestExecutionPath = "kai_command" | "voice_tool" | "route";
export type VoiceActionManifestExecutionHint =
  | {
      status: "wired";
      path: VoiceActionManifestExecutionPath;
      target: string;
      params?: Record<string, unknown>;
      intended_handler?: never;
      reason?: never;
    }
  | {
      status: "unwired";
      reason: string;
      intended_handler?: string;
      path?: never;
      target?: never;
      params?: never;
    }
  | {
      status: "dead";
      reason: string;
      path?: never;
      target?: never;
      params?: never;
      intended_handler?: never;
    };

export type VoiceActionManifestAction = {
  id: string;
  label: string;
  meaning: string;
  scope: {
    routes: string[];
    screens: string[];
    hidden_navigable: boolean;
    navigation_prerequisites: string[];
  };
  guard_ids: string[];
  risk_level: VoiceActionManifestRiskLevel;
  execution_policy: VoiceActionManifestExecutionPolicy;
  execution_hint: VoiceActionManifestExecutionHint;
  map_references: string[];
};

export type VoiceActionManifest = {
  schema_version: string;
  source_registry?: string;
  actions: VoiceActionManifestAction[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateExecutionHint(input: unknown): VoiceActionManifestExecutionHint | null {
  if (!isPlainObject(input) || typeof input.status !== "string") return null;

  if (input.status === "wired") {
    const path = input.path;
    const target = input.target;
    if (
      path !== "kai_command" &&
      path !== "voice_tool" &&
      path !== "route"
    ) {
      return null;
    }
    if (typeof target !== "string" || !target.trim()) return null;

    const normalized: VoiceActionManifestExecutionHint = {
      status: "wired",
      path,
      target: target.trim(),
    };

    if (input.params !== undefined) {
      if (!isPlainObject(input.params)) return null;
      normalized.params = input.params;
    }

    return normalized;
  }

  if (input.status === "unwired") {
    if (typeof input.reason !== "string" || !input.reason.trim()) return null;
    const normalized: VoiceActionManifestExecutionHint = {
      status: "unwired",
      reason: input.reason.trim(),
    };
    if (typeof input.intended_handler === "string" && input.intended_handler.trim()) {
      normalized.intended_handler = input.intended_handler.trim();
    }
    return normalized;
  }

  if (input.status === "dead") {
    if (typeof input.reason !== "string" || !input.reason.trim()) return null;
    return {
      status: "dead",
      reason: input.reason.trim(),
    };
  }

  return null;
}

function validateAction(input: unknown): VoiceActionManifestAction | null {
  if (!isPlainObject(input)) return null;

  if (
    typeof input.id !== "string" ||
    !input.id.trim() ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    typeof input.meaning !== "string" ||
    !input.meaning.trim()
  ) {
    return null;
  }

  if (!isPlainObject(input.scope)) return null;
  if (!isStringArray(input.scope.routes) || !isStringArray(input.scope.screens)) return null;
  if (!isStringArray(input.scope.navigation_prerequisites)) return null;
  if (typeof input.scope.hidden_navigable !== "boolean") return null;
  if (!isStringArray(input.guard_ids)) return null;
  if (
    input.risk_level !== "low" &&
    input.risk_level !== "medium" &&
    input.risk_level !== "high"
  ) {
    return null;
  }
  if (
    input.execution_policy !== "allow_direct" &&
    input.execution_policy !== "confirm_required" &&
    input.execution_policy !== "manual_only"
  ) {
    return null;
  }
  if (!isStringArray(input.map_references)) return null;

  const executionHint = validateExecutionHint(input.execution_hint);
  if (!executionHint) return null;

  return {
    id: input.id.trim(),
    label: input.label.trim(),
    meaning: input.meaning.trim(),
    scope: {
      routes: input.scope.routes.map((route) => route.trim()),
      screens: input.scope.screens.map((screen) => screen.trim()),
      hidden_navigable: input.scope.hidden_navigable,
      navigation_prerequisites: input.scope.navigation_prerequisites.map((item) => item.trim()),
    },
    guard_ids: input.guard_ids.map((guardId) => guardId.trim()),
    risk_level: input.risk_level,
    execution_policy: input.execution_policy,
    execution_hint: executionHint,
    map_references: input.map_references.map((reference) => reference.trim()),
  };
}

function validateManifest(input: unknown): VoiceActionManifest {
  if (!isPlainObject(input)) {
    throw new Error("Voice action manifest must be a plain object.");
  }
  if (typeof input.schema_version !== "string" || !input.schema_version.trim()) {
    throw new Error("Voice action manifest schema_version is required.");
  }
  if (!Array.isArray(input.actions)) {
    throw new Error("Voice action manifest actions must be an array.");
  }

  const actions = input.actions.map((action, index) => {
    const validated = validateAction(action);
    if (!validated) {
      throw new Error(`Voice action manifest action at index ${index} is invalid.`);
    }
    return validated;
  });

  return {
    schema_version: input.schema_version.trim(),
    source_registry:
      typeof input.source_registry === "string" && input.source_registry.trim()
        ? input.source_registry.trim()
        : undefined,
    actions,
  };
}

export const VOICE_ACTION_MANIFEST = validateManifest(manifestJson);
export const VOICE_ACTION_MANIFEST_ACTIONS = VOICE_ACTION_MANIFEST.actions;
export const VOICE_ACTION_MANIFEST_BY_ID = new Map(
  VOICE_ACTION_MANIFEST_ACTIONS.map((action) => [action.id, action] as const)
);

export function getVoiceActionManifestById(id: string): VoiceActionManifestAction | null {
  return VOICE_ACTION_MANIFEST_BY_ID.get(id) || null;
}

export function listVoiceActionManifestActions(): readonly VoiceActionManifestAction[] {
  return VOICE_ACTION_MANIFEST_ACTIONS;
}
