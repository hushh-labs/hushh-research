import {
  COUNT_BUCKETS,
  LIVE_MEMORY_SOURCE_KINDS,
  LIVE_MEMORY_SOURCE_OUTCOMES,
  MINUTE_DURATION_BUCKETS,
  GMAIL_CONNECT_RESULT_ACTIONS,
  GMAIL_CONNECT_STARTED_ACTIONS,
  GMAIL_SYNC_RESULT_ACTIONS,
  ONE_CALENDAR_ACTIONS,
  ONE_CRM_ACTIONS,
  ONE_KYC_ACTIONS,
  ONE_LOCATION_JOURNEY_ACTIONS,
  ONE_MEMORY_ACTIONS,
  ONE_WALLET_ACTIONS,
  type ObservabilityEventName,
  type PrimitiveEventValue,
} from "@/lib/observability/events";

/*
 * These enums are intentionally long, human-readable strings. They are safe
 * only in the exact event/key position declared here; every other long opaque
 * string still follows the conservative token/identifier rejection rule.
 */
const ONE_LOCATION_JOURNEY_ACTION_SET = new Set<string>(ONE_LOCATION_JOURNEY_ACTIONS);
export const GOVERNED_ACTIONS_BY_EVENT: Partial<Record<ObservabilityEventName, ReadonlySet<string>>> = {
  gmail_connect_started: new Set(GMAIL_CONNECT_STARTED_ACTIONS),
  gmail_connect_result: new Set(GMAIL_CONNECT_RESULT_ACTIONS),
  gmail_sync_requested: new Set(["manual"]),
  one_memory_action: new Set(ONE_MEMORY_ACTIONS),
  one_wallet_action: new Set(ONE_WALLET_ACTIONS),
  one_calendar_action: new Set(ONE_CALENDAR_ACTIONS),
  one_kyc_action: new Set(ONE_KYC_ACTIONS),
  one_crm_action: new Set(ONE_CRM_ACTIONS),
  gmail_sync_result: new Set(GMAIL_SYNC_RESULT_ACTIONS),
};
const GOVERNED_RESULTS = new Set(["success", "expected_error", "error"]);
export const GOVERNED_RESULTS_BY_EVENT: Partial<Record<ObservabilityEventName, ReadonlySet<string>>> = {
  gmail_connect_started: new Set(["success"]),
  gmail_connect_result: GOVERNED_RESULTS,
  gmail_disconnect_result: GOVERNED_RESULTS,
  gmail_sync_requested: new Set(["success"]),
  gmail_sync_result: GOVERNED_RESULTS,
  gmail_receipts_loaded: GOVERNED_RESULTS,
  one_memory_action: GOVERNED_RESULTS,
  one_wallet_action: GOVERNED_RESULTS,
  one_calendar_action: GOVERNED_RESULTS,
  one_kyc_action: GOVERNED_RESULTS,
  one_crm_action: GOVERNED_RESULTS,
};

/*
 * Events whose every dimension is a closed set. Each listed key is required,
 * and a missing key or a value outside its set drops the whole event: a stray
 * record id in `kind` or a raw count in a bucket can never reach analytics.
 */
const COUNT_BUCKET_SET: ReadonlySet<string> = new Set(COUNT_BUCKETS);
export const GOVERNED_VALUES_BY_EVENT: Partial<
  Record<ObservabilityEventName, ReadonlyMap<string, ReadonlySet<string>>>
> = {
  live_memory_source_verified: new Map([
    ["kind", new Set(LIVE_MEMORY_SOURCE_KINDS)],
    ["outcome", new Set(LIVE_MEMORY_SOURCE_OUTCOMES)],
    ["lag_bucket", new Set(MINUTE_DURATION_BUCKETS)],
    ["pending_bucket", COUNT_BUCKET_SET],
    ["retry_bucket", COUNT_BUCKET_SET],
  ]),
};

export function isGovernedLongString(
  eventName: ObservabilityEventName,
  key: string,
  value: PrimitiveEventValue,
): boolean {
  if (typeof value !== "string") return false;
  // A declared closed-set value, such as `document_request_payment`, is not
  // an opaque id, however long.
  if (GOVERNED_VALUES_BY_EVENT[eventName]?.get(key)?.has(value)) return true;
  return (
    eventName === "one_location_journey_action" &&
    key === "action" &&
    ONE_LOCATION_JOURNEY_ACTION_SET.has(value)
  );
}

export function isInvalidGovernedEnum(
  eventName: ObservabilityEventName,
  key: string,
  value: PrimitiveEventValue,
): boolean {
  const governedValues = GOVERNED_VALUES_BY_EVENT[eventName]?.get(key);
  if (governedValues) return typeof value !== "string" || !governedValues.has(value);
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
