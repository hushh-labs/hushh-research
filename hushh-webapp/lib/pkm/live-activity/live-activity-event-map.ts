/**
 * Closed map from governed analytics events to live activity input. It reads
 * only the schema-sanitized payload (enums, buckets and bounded counts) and
 * emits only authored kinds and allowlisted subjects. Owner actions that emit
 * no governed event record themselves at their success points instead.
 */

import type {
  ONE_CALENDAR_ACTIONS,
  ONE_WALLET_ACTIONS,
} from "@/lib/observability/actions";
import type { ConsentAction, ObservabilityEventName } from "@/lib/observability/events";
import type { LiveActivityInput, LiveActivityKind } from "./live-activity-types";

type Payload = Readonly<Record<string, unknown>>;
type Mapper = (payload: Payload) => LiveActivityInput | null;

const CONSENT_KINDS: Readonly<Record<ConsentAction, LiveActivityKind>> = {
  approve: "consent_approved",
  deny: "consent_declined",
  revoke: "consent_revoked",
};
const WALLET_KINDS: Readonly<Record<(typeof ONE_WALLET_ACTIONS)[number], LiveActivityKind>> = {
  card_added: "wallet_card_added",
  card_deleted: "wallet_card_removed",
};
const CALENDAR_KINDS: Readonly<Partial<Record<(typeof ONE_CALENDAR_ACTIONS)[number], LiveActivityKind>>> = {
  connected: "connector_connected",
  disconnected: "connector_disconnected",
};

const succeeded = (payload: Payload) => payload.result === "success";

function lookup<K extends string>(table: Readonly<Partial<Record<K, LiveActivityKind>>>, value: unknown): LiveActivityKind | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value)
    ? table[value as K] ?? null
    : null;
}

function kindOnly(kind: LiveActivityKind | null, subject: string | null = null): LiveActivityInput | null {
  return kind ? { kind, subject } : null;
}

const MAPPERS = new Map<ObservabilityEventName, Mapper>([
  ["gmail_connect_result", p => (p.action === "complete" && succeeded(p) ? kindOnly("connector_connected", "gmail") : null)],
  ["gmail_disconnect_result", p => (succeeded(p) ? kindOnly("connector_disconnected", "gmail") : null)],
  ["gmail_sync_result", p => {
    if (p.action !== "complete") return null;
    if (p.result === "success") return kindOnly("connector_synced", "gmail");
    return p.result === "error" ? kindOnly("connector_sync_failed", "gmail") : null;
  }],
  ["one_calendar_action", p => (succeeded(p) ? kindOnly(lookup(CALENDAR_KINDS, p.action), "google_calendar") : null)],
  ["consent_action_result", p => (succeeded(p) ? kindOnly(lookup(CONSENT_KINDS, p.action)) : null)],
  // one_location_share_confirmed is deliberately unmapped: a private Check-In
  // with people emits it too, so it cannot mean "started sharing location".
  ["one_location_public_link_created", p => (succeeded(p) ? kindOnly("location_sharing_started") : null)],
  ["one_location_journey_action", p => (
    p.action === "public_link_revoked" && succeeded(p) ? kindOnly("location_sharing_stopped") : null
  )],
  ["one_wallet_action", p => (succeeded(p) ? kindOnly(lookup(WALLET_KINDS, p.action)) : null)],
  ["agent_pkm_save_confirmation_completed", p => (
    succeeded(p) && typeof p.saved_count_bucket === "string" && p.saved_count_bucket !== "none"
      ? kindOnly("memory_saved")
      : null
  )],
  ["one_memory_action", p => (p.action === "capture_saved" && succeeded(p) ? kindOnly("memory_saved") : null)],
]);

/** Closed allowlist from governed analytics events (sanitized payloads only) to journal input. Unknown events -> null. */
export function liveActivityFromTrackedEvent(eventName: string, sanitized: Readonly<Record<string, unknown>>): LiveActivityInput | null {
  const mapper = MAPPERS.get(eventName as ObservabilityEventName);
  if (!mapper || !sanitized || typeof sanitized !== "object") return null;
  return mapper(sanitized);
}
