import { describe, expect, it } from "vitest";

import { isFeedItemHidden } from "@/lib/feed/feed-visibility";

describe("Feed row visibility", () => {
  it("always shows Drive sharing rows, even without the CRM build", () => {
    for (const event_type of [
      "document_share_outcome",
      "document_share_decided",
      "document_share_request",
      "document_share_question",
      "document_share_answered",
      "drive_search_completed",
      "drive_search_failed",
      "drive_share_unconfirmed",
      "drive_trash_succeeded",
      "drive_bulk_received",
      "drive_bulk_partial",
      "drive_bulk_stopped",
      "drive_question_withdrawn",
      "drive_question_retry_required",
      "connector_connected",
      "connector_disconnected",
      "connector_reconnect_required",
    ]) {
      expect(
        isFeedItemHidden({ source_domain: "connected_systems", event_type }, false),
      ).toBe(false);
    }
  });

  it.each([
    "calendar_connected",
    "calendar_reconnect_required",
    "calendar_disconnected",
    "calendar_event_created",
    "calendar_event_rescheduled",
    "calendar_event_canceled",
    "mail_connected",
    "mail_reconnect_required",
    "mail_disconnected",
    "mail_information_request_detected",
    "mail_receipts_imported",
    "mail_sync_completed",
    "mail_sync_failed",
    "mail_message_sent",
    "mail_message_failed",
    "mail_delivery_unconfirmed",
  ])("shows %s with CRM disabled", (event_type) => {
    expect(
      isFeedItemHidden({ source_domain: "connected_systems", event_type }, false),
    ).toBe(false);
  });

  it("keeps CRM rows behind the CRM build flag", () => {
    const crm = {
      source_domain: "connected_systems",
      event_type: "connected_systems_connected",
    } as const;
    expect(isFeedItemHidden(crm, false)).toBe(true);
    expect(isFeedItemHidden(crm, true)).toBe(false);
  });

  it("keeps own share receipts quiet while preserving incoming shares and Circle additions", () => {
    expect(
      isFeedItemHidden(
        { source_domain: "location", event_type: "location_share_created" },
        false,
      ),
    ).toBe(true);
    expect(isFeedItemHidden({ source_domain: "location", event_type: "location_share_created",
      metadata: { feed_audience: "recipient" } }, false)).toBe(false);
    expect(isFeedItemHidden({ source_domain: "location", event_type: "location_share_expired" }, false)).toBe(true);
    expect(isFeedItemHidden({ source_domain: "location", event_type: "circle_member_added" }, false)).toBe(false);
    expect(isFeedItemHidden({ source_domain: "connections", event_type: "connection_accepted",
      metadata: { actor_is_self: true } }, false)).toBe(true);
    expect(isFeedItemHidden({ source_domain: "connections", event_type: "connection_accepted",
      metadata: { actor_is_self: false } }, false)).toBe(false);
  });
});
