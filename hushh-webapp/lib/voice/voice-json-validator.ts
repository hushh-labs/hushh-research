import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import type {
  VoiceCanonicalPlanFields,
  VoiceMemoryHint,
  VoicePlanPayload,
  VoicePlanClarification,
  VoicePlanSlotValue,
  VoiceResponse,
  VoiceToolCall,
} from "@/lib/voice/voice-types";

const ALLOWED_COMMANDS = new Set<KaiCommandAction>([
  "analyze",
  "optimize",
  "import",
  "consent",
  "profile",
  "history",
  "dashboard",
  "home",
]);
export const VOICE_PLAN_NORMALIZATION_VERSION = "2026-03-13-stabilize-a";
const COMMAND_ALIASES: Record<string, KaiCommandAction> = {
  market: "home",
  market_section: "home",
  kai: "home",
  kai_section: "home",
  kai_home: "home",
  consents: "consent",
  portfolio: "dashboard",
  imports: "import",
  import_section: "import",
};

const ALLOWED_EXECUTE_ARG_KEYS = new Set(["command", "params"]);
const ALLOWED_EXECUTE_PARAM_KEYS = new Set(["symbol", "focus", "tab"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCanonicalPlanMode(
  value: unknown
): value is NonNullable<VoiceCanonicalPlanFields["mode"]> {
  return (
    value === "answer_now" ||
    value === "execute_and_wait" ||
    value === "start_background_and_ack" ||
    value === "clarify"
  );
}

function isReplyStrategy(
  value: unknown
): value is NonNullable<VoiceCanonicalPlanFields["reply_strategy"]> {
  return value === "template" || value === "llm";
}

function validateSlotValue(input: unknown): VoicePlanSlotValue | undefined {
  if (input === null) return null;
  if (
    typeof input === "string" ||
    typeof input === "boolean" ||
    typeof input === "number"
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    const normalized = input.map((item) => validateSlotValue(item));
    if (normalized.some((item) => item === undefined)) return undefined;
    return normalized as VoicePlanSlotValue[];
  }
  if (!isPlainObject(input)) return undefined;

  const normalized: Record<string, VoicePlanSlotValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const validated = validateSlotValue(value);
    if (validated === undefined) return undefined;
    normalized[key] = validated;
  }
  return normalized;
}

function validateClarification(input: unknown): VoicePlanClarification | null {
  if (!isPlainObject(input)) return null;
  if (typeof input.question !== "string" || !input.question.trim()) return null;

  const clarification: VoicePlanClarification = {
    question: input.question.trim(),
  };

  if (input.reason !== undefined) {
    if (input.reason !== null && typeof input.reason !== "string") return null;
    clarification.reason = typeof input.reason === "string" ? input.reason.trim() : null;
  }

  if (input.options !== undefined) {
    if (!isStringArray(input.options)) return null;
    clarification.options = input.options.map((option) => option.trim());
  }

  if (input.candidate !== undefined) {
    if (input.candidate !== null && typeof input.candidate !== "string") return null;
    clarification.candidate =
      typeof input.candidate === "string" ? input.candidate.trim() : null;
  }

  if (input.entity !== undefined) {
    if (input.entity !== null && typeof input.entity !== "string") return null;
    clarification.entity = typeof input.entity === "string" ? input.entity.trim() : null;
  }

  return clarification;
}

function validateCanonicalPlanFields(input: Record<string, unknown>): VoiceCanonicalPlanFields | null {
  const hasCanonicalField =
    input.schema_version !== undefined ||
    input.mode !== undefined ||
    input.action_id !== undefined ||
    input.slots !== undefined ||
    input.guards !== undefined ||
    input.reply_strategy !== undefined ||
    input.clarification !== undefined;

  if (!hasCanonicalField) return {};

  const canonical: VoiceCanonicalPlanFields = {};

  if (input.schema_version !== undefined) {
    if (typeof input.schema_version !== "string" || !input.schema_version.trim()) return null;
    canonical.schema_version = input.schema_version.trim();
  }

  if (!isCanonicalPlanMode(input.mode)) return null;
  canonical.mode = input.mode;

  if (input.action_id !== undefined) {
    if (input.action_id !== null && (typeof input.action_id !== "string" || !input.action_id.trim())) {
      return null;
    }
    canonical.action_id = typeof input.action_id === "string" ? input.action_id.trim() : null;
  }

  if (
    (canonical.mode === "execute_and_wait" || canonical.mode === "start_background_and_ack") &&
    !canonical.action_id
  ) {
    return null;
  }

  if (input.slots !== undefined) {
    if (!isPlainObject(input.slots)) return null;
    const normalizedSlots: Record<string, VoicePlanSlotValue> = {};
    for (const [key, value] of Object.entries(input.slots)) {
      const validated = validateSlotValue(value);
      if (validated === undefined) return null;
      normalizedSlots[key] = validated;
    }
    canonical.slots = normalizedSlots;
  }

  if (input.guards !== undefined) {
    if (!isStringArray(input.guards)) return null;
    canonical.guards = input.guards.map((guard) => guard.trim());
  }

  if (input.reply_strategy !== undefined) {
    if (!isReplyStrategy(input.reply_strategy)) return null;
    canonical.reply_strategy = input.reply_strategy;
  }

  if (input.clarification !== undefined) {
    if (input.clarification === null) {
      canonical.clarification = null;
    } else {
      const clarification = validateClarification(input.clarification);
      if (!clarification) return null;
      canonical.clarification = clarification;
    }
  }

  return canonical;
}

export function validateVoiceToolCall(input: unknown): VoiceToolCall | null {
  if (!isPlainObject(input)) return null;
  const toolName = input.tool_name;
  const args = input.args;
  if (typeof toolName !== "string" || !isPlainObject(args)) return null;

  if (toolName === "navigate_back" || toolName === "resume_active_analysis") {
    if (Object.keys(args).length > 0) return null;
    return {
      tool_name: toolName,
      args: {},
    };
  }

  if (toolName === "cancel_active_analysis") {
    if (Object.keys(args).length !== 1 || typeof args.confirm !== "boolean") return null;
    return {
      tool_name: "cancel_active_analysis",
      args: { confirm: args.confirm },
    };
  }

  if (toolName === "clarify") {
    const keys = Object.keys(args);
    if (!keys.every((key) => key === "question" || key === "options")) return null;
    if (typeof args.question !== "string" || !args.question.trim()) return null;
    if (args.options !== undefined) {
      if (!Array.isArray(args.options)) return null;
      if (!args.options.every((option) => typeof option === "string")) return null;
    }
    return {
      tool_name: "clarify",
      args: {
        question: args.question.trim(),
        options: Array.isArray(args.options) ? args.options : undefined,
      },
    };
  }

  if (toolName === "execute_kai_command") {
    const argKeys = Object.keys(args);
    if (!argKeys.every((key) => ALLOWED_EXECUTE_ARG_KEYS.has(key))) return null;

    if (typeof args.command !== "string") return null;
    const rawCommand = args.command.trim().toLowerCase().replace(/\s+/g, "_");
    let command = (COMMAND_ALIASES[rawCommand] || rawCommand) as KaiCommandAction;

    const normalized: {
      symbol?: string;
      focus?: "active";
      tab?: "history" | "debate" | "summary" | "transcript";
    } = {};

    if (args.params !== undefined) {
      if (!isPlainObject(args.params)) return null;
      const paramKeys = Object.keys(args.params);
      if (!paramKeys.every((key) => ALLOWED_EXECUTE_PARAM_KEYS.has(key))) return null;

      if (args.params.symbol !== undefined) {
        if (typeof args.params.symbol !== "string" || !args.params.symbol.trim()) return null;
        normalized.symbol = args.params.symbol.trim().toUpperCase();
      }

      if (args.params.focus !== undefined) {
        if (args.params.focus !== "active") return null;
        normalized.focus = "active";
      }

      if (args.params.tab !== undefined) {
        if (
          args.params.tab !== "history" &&
          args.params.tab !== "debate" &&
          args.params.tab !== "summary" &&
          args.params.tab !== "transcript"
        ) {
          return null;
        }
        normalized.tab = args.params.tab;
      }
    }

    if (!ALLOWED_COMMANDS.has(command)) return null;

    if (command === "analyze" && !normalized.symbol) {
      return null;
    }

    return {
      tool_name: "execute_kai_command",
      args: {
        command,
        params: Object.keys(normalized).length > 0 ? normalized : undefined,
      },
    };
  }

  return null;
}

function ensureSpeakTrue(input: unknown): true | null {
  return input === true ? true : null;
}

function validateVoiceMemoryHint(input: unknown): VoiceMemoryHint | undefined {
  if (!isPlainObject(input)) return undefined;
  if (typeof input.allow_durable_write !== "boolean") return undefined;
  return { allow_durable_write: input.allow_durable_write };
}

export function validateVoiceResponse(input: unknown): VoiceResponse | null {
  if (!isPlainObject(input)) return null;
  if (typeof input.kind !== "string") return null;
  if (typeof input.message !== "string" || !input.message.trim()) return null;
  if (!ensureSpeakTrue(input.speak)) return null;

  const message = input.message.trim();

  if (input.kind === "blocked") {
    if (typeof input.reason !== "string" || !input.reason.trim()) return null;
    return {
      kind: "blocked",
      reason: input.reason.trim(),
      message,
      speak: true,
    };
  }

  if (input.kind === "clarify") {
    if (
      input.reason !== "stt_unusable" &&
      input.reason !== "ticker_ambiguous" &&
      input.reason !== "ticker_unknown"
    ) {
      return null;
    }
    if (
      input.candidate !== undefined &&
      input.candidate !== null &&
      typeof input.candidate !== "string"
    ) {
      return null;
    }
    return {
      kind: "clarify",
      reason: input.reason,
      message,
      candidate: typeof input.candidate === "string" ? input.candidate : input.candidate ?? undefined,
      speak: true,
    };
  }

  if (input.kind === "already_running") {
    if (input.task !== "analysis" && input.task !== "import") return null;
    if (
      input.ticker !== undefined &&
      input.ticker !== null &&
      typeof input.ticker !== "string"
    ) {
      return null;
    }
    if (
      input.run_id !== undefined &&
      input.run_id !== null &&
      typeof input.run_id !== "string"
    ) {
      return null;
    }
    return {
      kind: "already_running",
      task: input.task,
      ticker: typeof input.ticker === "string" ? input.ticker : input.ticker ?? undefined,
      run_id: typeof input.run_id === "string" ? input.run_id : input.run_id ?? undefined,
      message,
      speak: true,
    };
  }

  if (input.kind === "execute") {
    const validatedToolCall = validateVoiceToolCall(input.tool_call);
    if (!validatedToolCall) return null;
    return {
      kind: "execute",
      tool_call: validatedToolCall,
      message,
      speak: true,
    };
  }

  if (input.kind === "background_started") {
    if (input.task !== "analysis") return null;
    if (typeof input.ticker !== "string" || !input.ticker.trim()) return null;
    if (typeof input.run_id !== "string" || !input.run_id.trim()) return null;
    return {
      kind: "background_started",
      task: "analysis",
      ticker: input.ticker.trim().toUpperCase(),
      run_id: input.run_id.trim(),
      message,
      speak: true,
    };
  }

  if (input.kind === "speak_only") {
    return {
      kind: "speak_only",
      message,
      speak: true,
    };
  }

  return null;
}

export function validateVoicePlanPayload(input: unknown): VoicePlanPayload | null {
  if (!isPlainObject(input)) return null;
  const response = validateVoiceResponse(input.response);
  if (!response) return null;
  const canonical = validateCanonicalPlanFields(input);
  if (!canonical) return null;

  const payload: VoicePlanPayload = {
    ...canonical,
    response,
  };

  const toolCall = validateVoiceToolCall(input.tool_call);
  if (toolCall) {
    payload.tool_call = toolCall;
  }

  const memory = validateVoiceMemoryHint(input.memory);
  if (memory) {
    payload.memory = memory;
  }

  if (typeof input.execution_allowed === "boolean") {
    payload.execution_allowed = input.execution_allowed;
  }
  if (typeof input.needs_confirmation === "boolean") {
    payload.needs_confirmation = input.needs_confirmation;
  }

  if (typeof input.elapsed_ms === "number") {
    payload.elapsed_ms = input.elapsed_ms;
  }
  if (typeof input.openai_http_ms === "number") {
    payload.openai_http_ms = input.openai_http_ms;
  }
  if (typeof input.model === "string") {
    payload.model = input.model;
  }

  return payload;
}

export function normalizeClarifyToolCall(question: string, options?: string[]): VoiceToolCall {
  return {
    tool_name: "clarify",
    args: {
      question: question.trim(),
      options: isStringArray(options) ? options : undefined,
    },
  };
}
