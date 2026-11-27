import {
  GMAIL_CONNECT_RESULT_ACTIONS,
  GMAIL_CONNECT_STARTED_ACTIONS,
  GMAIL_SYNC_RESULT_ACTIONS,
  ONE_CALENDAR_ACTIONS,
  ONE_KYC_ACTIONS,
  ONE_LOCATION_JOURNEY_ACTIONS,
  ONE_MEMORY_ACTIONS,
  ONE_WALLET_ACTIONS,
} from "./actions";
import type { ObservabilityEventName, PrimitiveEventValue } from "./events";

/**
 * Prospective reporting aliases, derived after schema validation. Raw `action`
 * and `result` are shared by unrelated event families and are not universally
 * runtime-enumerated. Never register those raw fields on behalf of One features.
 * These aliases accept exact reviewed enums only, never supplied aliases, IDs,
 * prose, normalized guesses, or a missing result. They are event observations,
 * not proof of a domain effect or an AI specialist completing a task.
 */
const actions = {
  one_memory_action: ONE_MEMORY_ACTIONS,
  one_wallet_action: ONE_WALLET_ACTIONS,
  one_calendar_action: ONE_CALENDAR_ACTIONS,
  one_kyc_action: ONE_KYC_ACTIONS,
  one_location_journey_action: ONE_LOCATION_JOURNEY_ACTIONS,
  gmail_connect_started: GMAIL_CONNECT_STARTED_ACTIONS,
  gmail_connect_result: GMAIL_CONNECT_RESULT_ACTIONS,
  gmail_sync_requested: ["manual"],
  gmail_sync_result: GMAIL_SYNC_RESULT_ACTIONS,
  consent_action_submitted: ["approve", "deny", "revoke"],
  consent_action_result: ["approve", "deny", "revoke"],
} as const satisfies Partial<Record<ObservabilityEventName, readonly string[]>>;

const results = ["success", "expected_error", "error"] as const;
const successOnlyEvents: ReadonlySet<ObservabilityEventName> = new Set([
  "gmail_connect_started", "gmail_sync_requested",
  "analysis_stream_started", "consent_action_submitted",
]);
const resultOnlyEvents: ReadonlySet<ObservabilityEventName> = new Set([
  "gmail_disconnect_result", "gmail_receipts_loaded",
  "portfolio_viewed", "recommendation_viewed", "analysis_stream_started",
  "import_parse_completed", "import_save_completed",
  "one_location_share_confirmed", "one_location_check_in_completed",
  "one_location_check_out_completed", "one_location_sos_triggered",
  "one_location_request_sent", "one_location_public_link_created",
  "one_location_contact_signal_synced", "one_location_circle_invite_created",
  "one_location_circle_created",
]);

type FeatureDimensions = {
  one_feature_action?: string;
  one_feature_result?: typeof results[number];
};

export function deriveOneFeatureDimensions(
  eventName: ObservabilityEventName,
  sanitized: Readonly<Record<string, PrimitiveEventValue>>,
): FeatureDimensions {
  const allowedActions: readonly string[] | undefined =
    Object.hasOwn(actions, eventName) ? actions[eventName as keyof typeof actions] : undefined;
  if (!allowedActions && !resultOnlyEvents.has(eventName)) return {};
  const result = sanitized.result;
  if (typeof result !== "string" || !results.includes(result as typeof results[number])) return {};
  if (successOnlyEvents.has(eventName) && result !== "success") return {};
  if (allowedActions) {
    const action = sanitized.action;
    if (typeof action !== "string" || !allowedActions.includes(action)) return {};
    return { one_feature_action: action, one_feature_result: result as typeof results[number] };
  }
  return { one_feature_result: result as typeof results[number] };
}
