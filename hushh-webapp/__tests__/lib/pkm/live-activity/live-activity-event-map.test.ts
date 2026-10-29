import { describe, expect, it } from "vitest";

import { liveActivityFromTrackedEvent } from "@/lib/pkm/live-activity/live-activity-event-map";

describe("liveActivityFromTrackedEvent", () => {
  it.each([
    ["gmail_connect_result", { action: "complete", result: "success" }, { kind: "connector_connected", subject: "gmail" }],
    ["gmail_disconnect_result", { result: "success" }, { kind: "connector_disconnected", subject: "gmail" }],
    ["gmail_sync_result", { action: "complete", result: "success" }, { kind: "connector_synced", subject: "gmail" }],
    ["gmail_sync_result", { action: "complete", result: "error" }, { kind: "connector_sync_failed", subject: "gmail" }],
    ["one_calendar_action", { route_id: "calendar", action: "connected", result: "success" }, { kind: "connector_connected", subject: "google_calendar" }],
    ["one_calendar_action", { route_id: "calendar", action: "disconnected", result: "success" }, { kind: "connector_disconnected", subject: "google_calendar" }],
    ["consent_action_result", { action: "approve", result: "success" }, { kind: "consent_approved", subject: null }],
    ["consent_action_result", { action: "deny", result: "success" }, { kind: "consent_declined", subject: null }],
    ["consent_action_result", { action: "revoke", result: "success" }, { kind: "consent_revoked", subject: null }],
    ["one_location_public_link_created", { route_id: "one_location", result: "success" }, { kind: "location_sharing_started", subject: null }],
    ["one_location_journey_action", { action: "public_link_revoked", result: "success" }, { kind: "location_sharing_stopped", subject: null }],
    ["one_wallet_action", { route_id: "one_wallet", action: "card_added", result: "success" }, { kind: "wallet_card_added", subject: null }],
    ["one_wallet_action", { route_id: "one_wallet", action: "card_deleted", result: "success" }, { kind: "wallet_card_removed", subject: null }],
    ["agent_pkm_save_confirmation_completed", { route_id: "agent", result: "success", saved_count_bucket: "1_9" }, { kind: "memory_saved", subject: null }],
    ["one_memory_action", { route_id: "pkm", action: "capture_saved", result: "success" }, { kind: "memory_saved", subject: null }],
  ])("maps %s %j", (eventName, payload, expected) => {
    expect(liveActivityFromTrackedEvent(eventName, payload)).toEqual(expected);
  });

  it.each([
    ["page_view", { route_id: "one_location" }],
    ["constructor", {}],
    ["gmail_connect_result", { action: "start", result: "success" }],
    ["gmail_connect_result", { action: "complete", result: "error" }],
    ["gmail_sync_result", { action: "poll", result: "error" }],
    ["gmail_sync_result", { action: "complete", result: "expected_error" }],
    ["one_calendar_action", { action: "chat_opened", result: "success" }],
    ["consent_action_result", { action: "approve", result: "error" }],
    ["consent_action_result", { action: "toString", result: "success" }],
    // A Check-In with people confirms a share from the Location page too, so share_confirmed never means live sharing.
    ["one_location_share_confirmed", { route_id: "one_location", result: "success", success_count: 2 }],
    ["one_location_share_confirmed", { route_id: "one_location_check_in", result: "success", success_count: 1 }],
    ["one_location_journey_action", { action: "public_link_shared", result: "success" }],
    ["agent_pkm_save_confirmation_completed", { result: "success", saved_count_bucket: "none" }],
    ["one_memory_action", { action: "detail_deleted", result: "success" }],
    ["one_kyc_action", { action: "reply_sent", result: "success" }],
  ])("ignores %s %j", (eventName, payload) => {
    expect(liveActivityFromTrackedEvent(eventName, payload)).toBeNull();
  });
});
