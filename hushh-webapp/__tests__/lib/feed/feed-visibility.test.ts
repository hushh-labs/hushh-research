import { describe, expect, it } from "vitest";
import { isFeedItemHidden } from "@/lib/feed/feed-visibility";

const row = (event_type: string, source_domain = "connected_systems") => ({ event_type, source_domain }) as Parameters<typeof isFeedItemHidden>[0];

describe("Feed admission", () => {
  it("removes routine search, sync, progress and repeated confirmations from cached history", () => {
    for (const event of ["drive_search_completed", "drive_search_failed", "drive_bulk_received", "connector_connected",
      "connector_disconnected", "calendar_connected", "calendar_disconnected", "mail_connected", "mail_disconnected",
      "mail_receipts_imported", "mail_sync_completed", "mail_sync_failed", "kai_import_completed", "consent_timed_out",
      "profile_discovery_queued", "profile_discovery_scanning", "personal_agent_provisioning"]) {
      expect(isFeedItemHidden(row(event), true), event).toBe(true);
    }
  });
  it("keeps important outcomes and current decisions without requiring CRM", () => {
    for (const event of ["document_share_outcome", "drive_share_unconfirmed", "drive_bulk_partial", "drive_trash_succeeded",
      "connector_reconnect_required", "calendar_reconnect_required", "calendar_event_created", "mail_reconnect_required",
      "mail_information_request_detected", "mail_message_sent", "mail_message_failed", "mail_delivery_unconfirmed"]) {
      expect(isFeedItemHidden(row(event), false), event).toBe(false);
    }
    expect(isFeedItemHidden(row("location_share_created", "location"), false)).toBe(false);
  });
  it("preserves the CRM build boundary for admitted failures", () => {
    expect(isFeedItemHidden(row("connected_systems_mutation_partial"), false)).toBe(true);
    expect(isFeedItemHidden(row("connected_systems_mutation_partial"), true)).toBe(false);
    expect(isFeedItemHidden(row("connected_systems_connected"), true)).toBe(true);
  });
  it("hides cached progress and owner setup confirmations using the same metadata policy", () => {
    expect(isFeedItemHidden({ ...row("funding_transfer_status", "kai"), metadata: { user_facing_status: "pending" } }, true)).toBe(true);
    expect(isFeedItemHidden({ ...row("funding_transfer_status", "kai"), metadata: { user_facing_status: "returned" } }, true)).toBe(false);
    expect(isFeedItemHidden({ ...row("pwm_research", "pwm"), metadata: { pwm_outcome: "attention" } }, true)).toBe(true);
    expect(isFeedItemHidden({ ...row("location_sms_contact_added", "location"), metadata: { feed_audience: "owner" } }, true)).toBe(false);
  });
  it("keeps ordinary Chat quiet while preserving source-backed Card decisions and outcomes", () => {
    const message = row("direct_message_received", "connections");
    expect(isFeedItemHidden(message, true)).toBe(true);
    expect(isFeedItemHidden({ ...message, metadata:{wallet_card_request_id:"unverified-marker"} }, true)).toBe(true);
    for (const activity_group_id of ["wallet-request:verified", "wallet-access:verified"])
      expect(isFeedItemHidden({ ...message, activity_group_id }, true)).toBe(false);
  });
  it("does not turn unknown events into visible noise", () => {
    expect(isFeedItemHidden(row("future_unreviewed_event", "kai"), true)).toBe(true);
    for (const event of ["location_nearby_checked_in", "location_nearby_checked_out", "location_gps_updated", "location_public_link_opened"]) {
      expect(isFeedItemHidden(row(event, "location"), true), event).toBe(true);
    }
  });
});
