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

  it("never hides other domains", () => {
    expect(
      isFeedItemHidden(
        { source_domain: "location", event_type: "location_share_created" },
        false,
      ),
    ).toBe(false);
  });
});
