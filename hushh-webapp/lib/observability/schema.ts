import type {
  EventPayloadWithContextFor,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";

const BASE_ALLOWED_KEYS = ["env", "platform", "route_id"] as const;

const EVENT_ALLOWED_KEYS: Record<ObservabilityEventName, readonly string[]> = {
  page_view: [...BASE_ALLOWED_KEYS, "nav_type"],
  auth_started: [...BASE_ALLOWED_KEYS, "action"],
  auth_succeeded: [...BASE_ALLOWED_KEYS, "action", "result"],
  auth_failed: [...BASE_ALLOWED_KEYS, "action", "result", "error_class"],
  onboarding_started: [...BASE_ALLOWED_KEYS, "source"],
  onboarding_step_completed: [...BASE_ALLOWED_KEYS, "action", "result"],
  onboarding_completed: [...BASE_ALLOWED_KEYS, "action", "result"],
  import_upload_started: [...BASE_ALLOWED_KEYS, "result"],
  import_parse_completed: [...BASE_ALLOWED_KEYS, "result"],
  import_quality_gate_passed: [...BASE_ALLOWED_KEYS, "result"],
  import_quality_gate_failed: [...BASE_ALLOWED_KEYS, "result"],
  import_save_completed: [...BASE_ALLOWED_KEYS, "result"],
  market_insights_loaded: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "status_bucket",
    "duration_ms_bucket",
  ],
  profile_picks_loaded: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "status_bucket",
    "duration_ms_bucket",
  ],
  analysis_stream_started: [...BASE_ALLOWED_KEYS, "result"],
  analysis_stream_terminal_decision: [...BASE_ALLOWED_KEYS, "result"],
  analysis_stream_aborted: [...BASE_ALLOWED_KEYS, "result", "reason"],
  analysis_stream_error: [...BASE_ALLOWED_KEYS, "result", "error_class"],
  consent_pending_loaded: [...BASE_ALLOWED_KEYS, "result"],
  consent_action_submitted: [...BASE_ALLOWED_KEYS, "action", "result"],
  consent_action_result: [...BASE_ALLOWED_KEYS, "action", "result", "status_bucket"],
  persona_switched: [...BASE_ALLOWED_KEYS, "action", "result"],
  ria_onboarding_submitted: [...BASE_ALLOWED_KEYS, "result"],
  ria_verification_status_changed: [...BASE_ALLOWED_KEYS, "action", "result"],
  marketplace_profile_viewed: [...BASE_ALLOWED_KEYS, "action", "result"],
  ria_request_created: [...BASE_ALLOWED_KEYS, "result", "status_bucket"],
  ria_request_blocked_policy: [...BASE_ALLOWED_KEYS, "result", "error_class"],
  ria_workspace_opened: [...BASE_ALLOWED_KEYS, "result", "status_bucket"],
  mcp_ria_read_tool_called: [...BASE_ALLOWED_KEYS, "action", "result"],
  profile_method_switch_result: [...BASE_ALLOWED_KEYS, "result"],
  account_delete_requested: [...BASE_ALLOWED_KEYS, "result"],
  account_delete_completed: [...BASE_ALLOWED_KEYS, "result", "status_bucket"],
  gmail_connect_started: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_connect_result: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_disconnect_result: [...BASE_ALLOWED_KEYS, "result"],
  gmail_sync_requested: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_sync_result: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_receipts_loaded: [...BASE_ALLOWED_KEYS, "result"],
  api_request_completed: [
    ...BASE_ALLOWED_KEYS,
    "endpoint_template",
    "http_method",
    "result",
    "status_bucket",
    "duration_ms_bucket",
    "retry_count",
  ],
};

const DENYLIST_KEY_REGEX =
  /(^|_)(user(id)?|uid|email|name|phone|address|token|secret|symbol|ticker|amount|price|value|message|text|prompt|query|run_id|request_id|debate_session_id)(_|$)/i;

const EMAIL_VALUE_REGEX = /[^\s]+@[^\s]+\.[^\s]+/;

function isPrimitiveValue(value: unknown): value is PrimitiveEventValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function looksSensitiveValue(value: PrimitiveEventValue): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (EMAIL_VALUE_REGEX.test(trimmed)) return true;

  // Opaque IDs/tokens are high entropy and not useful in analytics payloads.
  if (/^[A-Za-z0-9_\-]{24,}$/.test(trimmed)) return true;

  return false;
}

export interface EventValidationResult {
  ok: boolean;
  sanitized: Record<string, PrimitiveEventValue>;
  droppedKeys: string[];
}

export function validateAndSanitizeEvent<T extends ObservabilityEventName>(
  eventName: T,
  payload: EventPayloadWithContextFor<T>
): EventValidationResult {
  const allowed = new Set(EVENT_ALLOWED_KEYS[eventName]);
  const sanitized: Record<string, PrimitiveEventValue> = {};
  const droppedKeys: string[] = [];

  for (const [key, value] of Object.entries(payload as unknown as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      droppedKeys.push(key);
      continue;
    }

    if (DENYLIST_KEY_REGEX.test(key) && key !== "route_id") {
      droppedKeys.push(key);
      continue;
    }

    if (!isPrimitiveValue(value)) {
      droppedKeys.push(key);
      continue;
    }

    if (looksSensitiveValue(value)) {
      droppedKeys.push(key);
      continue;
    }

    sanitized[key] = value;
  }

  return {
    ok: droppedKeys.length === 0,
    sanitized,
    droppedKeys,
  };
}
