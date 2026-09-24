import {
  GMAIL_CONNECT_RESULT_ACTIONS,
  GMAIL_CONNECT_STARTED_ACTIONS,
  GMAIL_SYNC_RESULT_ACTIONS,
  ONE_CALENDAR_ACTIONS,
  ONE_CRM_ACTIONS,
  ONE_KYC_ACTIONS,
  ONE_LOCATION_JOURNEY_ACTIONS,
  ONE_MEMORY_ACTIONS,
  ONE_WALLET_ACTIONS,
  type EventPayloadWithContextFor,
  type ObservabilityEventName,
  type PrimitiveEventValue,
} from "@/lib/observability/events";

/*
 * These enums are intentionally long, human-readable strings. They are safe
 * only in the exact event/key position declared here; every other long opaque
 * string still follows the conservative token/identifier rejection rule.
 */
const ONE_LOCATION_JOURNEY_ACTION_SET = new Set<string>(ONE_LOCATION_JOURNEY_ACTIONS);
const GOVERNED_ACTIONS_BY_EVENT: Partial<Record<ObservabilityEventName, ReadonlySet<string>>> = {
  gmail_connect_started: new Set(GMAIL_CONNECT_STARTED_ACTIONS),
  gmail_connect_result: new Set(GMAIL_CONNECT_RESULT_ACTIONS),
  one_memory_action: new Set(ONE_MEMORY_ACTIONS),
  one_wallet_action: new Set(ONE_WALLET_ACTIONS),
  one_calendar_action: new Set(ONE_CALENDAR_ACTIONS),
  one_kyc_action: new Set(ONE_KYC_ACTIONS),
  one_crm_action: new Set(ONE_CRM_ACTIONS),
  gmail_sync_result: new Set(GMAIL_SYNC_RESULT_ACTIONS),
};
const GOVERNED_RESULTS = new Set(["success", "expected_error", "error"]);
const GOVERNED_RESULTS_BY_EVENT: Partial<Record<ObservabilityEventName, ReadonlySet<string>>> = {
  gmail_connect_started: new Set(["success"]),
  gmail_connect_result: GOVERNED_RESULTS,
  gmail_sync_result: GOVERNED_RESULTS,
  one_memory_action: GOVERNED_RESULTS,
  one_wallet_action: GOVERNED_RESULTS,
  one_calendar_action: GOVERNED_RESULTS,
  one_kyc_action: GOVERNED_RESULTS,
  one_crm_action: GOVERNED_RESULTS,
};

const BASE_ALLOWED_KEYS = [
  "env",
  "platform",
  "event_category",
  "app_version",
  "route_id",
] as const;

const EVENT_ALLOWED_KEYS: Record<ObservabilityEventName, readonly string[]> = {
  one_memory_action: [...BASE_ALLOWED_KEYS, "action", "result"],
  one_wallet_action: [...BASE_ALLOWED_KEYS, "action", "result"],
  one_calendar_action: [...BASE_ALLOWED_KEYS, "action", "result"],
  one_kyc_action: [...BASE_ALLOWED_KEYS, "action", "result"],
  one_crm_action: [...BASE_ALLOWED_KEYS, "action", "result"],
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
  portfolio_viewed: [...BASE_ALLOWED_KEYS, "result", "portfolio_source"],
  recommendation_viewed: [...BASE_ALLOWED_KEYS, "result", "portfolio_source"],
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
  consent_pending_loaded: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "pending_count_bucket",
    "load_surface",
  ],
  consent_action_submitted: [...BASE_ALLOWED_KEYS, "action", "result"],
  consent_action_result: [...BASE_ALLOWED_KEYS, "action", "result", "status_bucket"],
  phone_verification_started: [...BASE_ALLOWED_KEYS, "action", "result"],
  phone_verification_completed: [...BASE_ALLOWED_KEYS, "action", "result"],
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
  account_reset_requested: [...BASE_ALLOWED_KEYS, "result"],
  account_reset_completed: [...BASE_ALLOWED_KEYS, "result", "status_bucket"],
  gmail_connect_started: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_connect_result: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_disconnect_result: [...BASE_ALLOWED_KEYS, "result"],
  gmail_sync_requested: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_sync_result: [...BASE_ALLOWED_KEYS, "action", "result"],
  gmail_receipts_loaded: [...BASE_ALLOWED_KEYS, "result"],
  growth_funnel_step_completed: [
    ...BASE_ALLOWED_KEYS,
    "journey",
    "step",
    "entry_surface",
    "auth_method",
    "portfolio_source",
    "workspace_source",
    "invite_source",
    "app_version",
  ],
  investor_activation_completed: [
    ...BASE_ALLOWED_KEYS,
    "journey",
    "entry_surface",
    "auth_method",
    "portfolio_source",
    "app_version",
  ],
  ria_activation_completed: [
    ...BASE_ALLOWED_KEYS,
    "journey",
    "entry_surface",
    "auth_method",
    "workspace_source",
    "app_version",
  ],
  one_location_activation_completed: [
    ...BASE_ALLOWED_KEYS,
    "journey",
    "activation_path",
    "entry_surface",
    "auth_method",
    "invite_source",
    "recipient_count_bucket",
    "share_duration_bucket",
    "app_version",
  ],
  one_location_setup_completed: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
    "settlement_retries",
  ],
  one_location_check_in_completed: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
    "selected_count",
    "success_count",
    "failure_count",
    "circle_targeted",
  ],
  one_location_check_out_completed: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
  ],
  one_location_visit_rated: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
    "stars",
    "has_note",
    "has_place_id",
  ],
  one_location_review_handoff_opened: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "destination",
  ],
  one_location_circle_created: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
    "circle_kind",
  ],
  one_location_journey_action: [
    ...BASE_ALLOWED_KEYS,
    "action",
    "result",
    "entry_surface",
    "target_type",
    "circle_kind",
    "count_bucket",
  ],
  one_location_sos_triggered: [
    ...BASE_ALLOWED_KEYS,
    "route_id",
    "result",
    "selected_count",
    "reached_count",
    "unreachable_count",
    "emailed_count",
    "has_note",
  ],
  api_request_completed: [
    ...BASE_ALLOWED_KEYS,
    "endpoint_template",
    "http_method",
    "result",
    "status_bucket",
    "duration_ms_bucket",
    "retry_count",
  ],
  route_readiness_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "render_path",
    "cache_tier",
    "resource_class",
    "duration_ms_bucket",
    "blocking_loader_shown",
    "stale_rendered",
  ],
  cache_resource_resolved: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "resource_class",
    "cache_tier",
    "freshness",
    "duration_ms_bucket",
    "footprint_bucket",
  ],
  route_refresh_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "resource_class",
    "refresh_trigger",
    "duration_ms_bucket",
    "retry_count",
  ],
  warmup_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "resource_class",
    "cache_tier",
    "warm_priority",
    "duration_ms_bucket",
    "footprint_bucket",
  ],
  startup_readiness_warmup_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "warm_priority",
    "duration_ms",
    "duration_ms_bucket",
    "onboarding_synced",
    "metadata_warmed",
    "financial_warmed",
    "kai_market_warmed",
    "dashboard_picks_warmed",
    "consents_warmed",
    "vault_status_warmed",
    "agent_context_warmed",
  ],
  agent_pkm_context_resolved: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "context_mode",
    "total_fact_count_bucket",
    "selected_fact_count_bucket",
    "context_clipped",
    "inventory_only",
    "safety_omitted",
    "duration_ms_bucket",
  ],
  agent_pkm_context_unavailable: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "reason",
  ],
  agent_pkm_save_confirmation_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "saved_count_bucket",
    "failed_count_bucket",
    "has_active_recipients",
  ],
  one_location_foreground_retry: [
    ...BASE_ALLOWED_KEYS,
    "operation",
    "trigger",
    "result",
    "attempt_count",
    "retry_count",
    "backoff_bucket",
    "duration_ms_bucket",
    "error_class",
  ],
  one_location_share_confirmed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "selected_count",
    "success_count",
    "failure_count",
    "duration_bucket",
    "review_required",
  ],
  one_location_onboarding_completed: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "exited_via",
    "code_shared",
    "code_copied",
    "screens_seen",
    "contacts_matched",
    "contacts_added",
  ],
  one_location_contact_signal_synced: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "source_platform",
    "contact_count_bucket",
    "matched_count",
    "invite_candidate_count",
    "contact_region",
    "partial_access",
    "truncated",
    "failure_reason",
  ],
  one_location_request_sent: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "selected_count",
    "success_count",
    "failure_count",
    "has_note",
  ],
  one_location_public_link_created: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "duration_bucket",
    "copied_to_clipboard",
    "active_invite_count",
  ],
  one_location_circle_invite_created: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "duration_bucket",
    "copied_to_clipboard",
    "active_invite_count",
  ],
  one_location_recommendation_selected: [
    ...BASE_ALLOWED_KEYS,
    "action",
    "result",
    "selection_surface",
    "recommendation_category",
    "recommendation_tier",
    "selected_count",
    "can_receive_location",
  ],
  one_location_share_review_opened: [
    ...BASE_ALLOWED_KEYS,
    "result",
    "selected_count",
    "duration_bucket",
    "has_permission_warning",
    "has_professional_signal",
    "has_setup_warning",
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

function isGovernedLongString(
  eventName: ObservabilityEventName,
  key: string,
  value: PrimitiveEventValue,
): boolean {
  return (
    eventName === "one_location_journey_action" &&
    key === "action" &&
    typeof value === "string" &&
    ONE_LOCATION_JOURNEY_ACTION_SET.has(value)
  );
}

function isInvalidGovernedEnum(
  eventName: ObservabilityEventName,
  key: string,
  value: PrimitiveEventValue,
): boolean {
  if (typeof value !== "string") return key === "action" || key === "result";
  if (key === "action") {
    const actions = GOVERNED_ACTIONS_BY_EVENT[eventName];
    return Boolean(actions && !actions.has(value));
  }
  if (key === "result") {
    const results = GOVERNED_RESULTS_BY_EVENT[eventName];
    return Boolean(results && !results.has(value));
  }
  return false;
}

export interface EventValidationResult {
  ok: boolean;
  /** Invalid governed action/result values make the whole event unsafe to emit. */
  fatal: boolean;
  sanitized: Record<string, PrimitiveEventValue>;
  droppedKeys: string[];
}

export function validateAndSanitizeEvent<T extends ObservabilityEventName>(
  eventName: T,
  payload: EventPayloadWithContextFor<T>
): EventValidationResult {
  const rawPayload = payload as unknown as Record<string, unknown>;
  const allowed = new Set(EVENT_ALLOWED_KEYS[eventName]);
  const sanitized: Record<string, PrimitiveEventValue> = {};
  const droppedKeys: string[] = [];
  let fatal = false;

  // Governed actions/results are required dimensions, not optional metadata.
  // Validate presence before iterating: omitted and explicitly undefined keys
  // would otherwise never reach the enum validator below.
  const requiredGovernedKeys = [
    ...(GOVERNED_ACTIONS_BY_EVENT[eventName] ? ["action"] : []),
    ...(GOVERNED_RESULTS_BY_EVENT[eventName] ? ["result"] : []),
  ];
  for (const key of requiredGovernedKeys) {
    if (typeof rawPayload[key] !== "string") {
      fatal = true;
      droppedKeys.push(key);
    }
  }

  for (const [key, value] of Object.entries(rawPayload)) {
    if (!allowed.has(key)) {
      droppedKeys.push(key);
      continue;
    }

    if (DENYLIST_KEY_REGEX.test(key) && key !== "route_id") {
      droppedKeys.push(key);
      continue;
    }

    if (!isPrimitiveValue(value)) {
      if (!droppedKeys.includes(key)) droppedKeys.push(key);
      continue;
    }

    if (isInvalidGovernedEnum(eventName, key, value)) {
      droppedKeys.push(key);
      fatal = true;
      continue;
    }

    if (looksSensitiveValue(value) && !isGovernedLongString(eventName, key, value)) {
      droppedKeys.push(key);
      continue;
    }

    sanitized[key] = value;
  }

  return {
    ok: droppedKeys.length === 0,
    fatal,
    sanitized,
    droppedKeys,
  };
}
