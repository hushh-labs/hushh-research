import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";
import {
  findAnalysisHistoryEntryByRouteId,
  type AnalysisHistoryEntry,
} from "@/lib/services/kai-history-service";

function feedItem(
  eventType: string,
  metadata: Record<string, unknown>,
  sourceDomain: FeedItem["source_domain"] = "location",
): FeedItem {
  return {
    id: `feed:${eventType}`,
    source_domain: sourceDomain,
    event_type: eventType,
    actor_label: null,
    metadata,
    read: false,
    created_at: "2026-08-26T00:00:00.000Z",
  };
}

describe("notification-backed Feed projection renderers", () => {
  it.each([
    ["kai_analysis_failed", "kai", "Analysis could not finish"],
    ["kai_analysis_canceled", "kai", "Analysis canceled"],
    ["kai_import_completed", "kai", "Statement parsing finished"],
    ["kai_import_failed", "kai", "Statement import could not finish"],
    ["kai_import_canceled", "kai", "Statement import canceled"],
    ["calendar_action_failed", "connected_systems", "Calendar change needs review"],
    ["mail_mailbox_archive", "connected_systems", "Messages archived"],
    ["mail_mailbox_trash", "connected_systems", "Messages moved to trash"],
    ["mail_mailbox_add_label", "connected_systems", "Label added"],
    ["mail_mailbox_remove_label", "connected_systems", "Label removed"],
    ["mail_mailbox_mark_read", "connected_systems", "Messages marked as read"],
    ["mail_mailbox_mark_unread", "connected_systems", "Messages marked as unread"],
    ["mail_mailbox_failed", "connected_systems", "Mailbox change needs review"],
    ["connected_systems_mutation_succeeded", "connected_systems", "App change completed"],
    ["connected_systems_mutation_partial", "connected_systems", "App change needs review"],
    ["drive_search_completed", "connected_systems", "Drive search finished"],
    ["drive_bulk_stopped", "connected_systems", "Drive sharing stopped"],
  ] as const)("presents %s with authored copy and a local destination", (type, domain, label) => {
    const view = presentFeedItem(feedItem(type, { error: "private-provider-error", filename: "private.pdf", payload: "private-holdings", request_url: "https://evil.example" }, domain));
    expect(view.label).toBe(label);
    expect(view.href).toMatch(/^\/(?:one(?:\/|\?)|$)/);
    expect(JSON.stringify(view)).not.toContain("private");
    expect(JSON.stringify(view)).not.toContain("evil.example");
  });

  it("distinguishes uncertain Drive writes from failure without suggesting a blind retry", () => {
    for (const type of ["drive_share_unconfirmed", "drive_trash_unconfirmed"]) {
      const view = presentFeedItem(feedItem(type, {}, "connected_systems"));
      expect(view.label).toContain("unconfirmed");
      expect(view.description).toContain("before trying again");
      expect(view.description).toContain("may have succeeded");
    }
    // These source outcomes also include successful writes whose readback
    // failed or could not establish who created the permission.
    for (const type of ["connected_systems_mutation_partial", "drive_bulk_partial", "drive_bulk_failed"]) {
      const view = presentFeedItem(feedItem(type, {}, "connected_systems"));
      expect(view.description).toContain("could not be confirmed");
      expect(view.description).toContain("before trying again");
      expect(view.description).not.toContain("Some files could not be shared");
      expect(view.description).not.toContain("Only part of your approved change finished");
    }
  });

  it("reports mixed-bundle expiry without claiming that nothing was shared", () => {
    const view = presentFeedItem(feedItem("consent_timed_out", {}, "consent"));
    expect(view.description).toBe("An unanswered part of this request expired.");
    expect(view.href).toContain("previous");
  });

  it("presents relationship outcomes for the actual audience", () => {
    expect(presentFeedItem(feedItem("connection_withdrawn", { counterpart_label: "Rohan", actor_is_self: true }, "connections")).description).toBe("You withdrew the connection request");
    expect(presentFeedItem(feedItem("connection_withdrawn", { counterpart_label: "Rohan" }, "connections")).description).toBe("Withdrew the connection request");
    const circle = presentFeedItem(feedItem("circle_membership_ended", { circle_name: "Family", actor: "private" }));
    expect(circle.label).toBe("Family");
    expect(circle.description).toBe("Your membership in this circle ended.");
    expect(JSON.stringify(circle)).not.toContain("private");
    const left = presentFeedItem(feedItem("circle_member_left", { circle_name: "Family", counterpart_label: "Aarav" }));
    expect(left.label).toBe("Family");
    expect(left.description).toBe("Aarav left your circle.");
    expect(left.href).toBe("/one/connect?tab=circles");
  });
  it("opens circle chat from metadata without exposing a message preview or trusting an external destination", () => {
    const circle = "11111111-2222-3333-4444-555555555555";
    const presented = presentFeedItem(feedItem("location_circle_message", { circle_id: circle, circle_name: "Family", message: "private plaintext", request_url: "https://evil.example" }));
    expect(presented.href).toContain(`circleId=${circle}&circleChat=1`);
    expect(JSON.stringify(presented)).not.toContain("private plaintext");
    expect(presentFeedItem(feedItem("location_circle_message", { circle_id: "invalid" })).href).toBeNull();
  });
  it("renders a recipient Direct Message preview with only the canonical inbox route", () => {
    const conversationId = "11111111-2222-4333-8444-555555555555";
    const presented = presentFeedItem(
      feedItem(
        "direct_message_received",
        {
          counterpart_label: "Rohan",
          direct_message_conversation_id: conversationId,
          message_preview: "hi",
          request_url: "https://evil.example/steal",
        },
        "connections",
      ),
    );

    expect(presented.domainLabel).toBe("Messages");
    expect(presented.label).toBe("Rohan");
    expect(presented.description).toBe("hi");
    expect(presented.href).toBe(`/one/messages?conversation=${conversationId}`);

    const fallback = presentFeedItem(
      feedItem(
        "direct_message_received",
        {
          message: "private body must not be promoted",
          request_url: "https://evil.example/steal",
          direct_message_conversation_id: "not-a-uuid",
        },
        "connections",
      ),
    );
    expect(fallback.description).toBe("Sent you a message");
    expect(fallback.href).toBe("/one/messages");
    expect(JSON.stringify(fallback)).not.toContain("private body");
  });
  it.each([
    ["location_share_created", "recipient", {}],
    ["location_share_created", "recipient", { duration_mode: "until_stopped" }],
    ["location_share_created", "recipient", { share_kind: "sos" }],
    ["location_access_approved", "requester", {}],
    ["location_access_approved", "requester", { is_extension: true }],
    ["location_share_shortened", "recipient", { reason: "owner_shorten" }],
    ["location_share_duration_changed", "recipient", { direction: "extended" }],
    [
      "location_share_duration_changed",
      "recipient",
      { direction: "shortened" },
    ],
    [
      "location_share_duration_changed",
      "recipient",
      { direction: "until_stopped" },
    ],
  ])(
    "lands incoming %s/%s on Shared with me",
    (eventType, audience, metadata) => {
      // Current created-share Feed rows have no grant ID. Older history and
      // duration/approval rows carrying IDs must all use the same list landing,
      // without auto-opening a map or leaving stale deep-link intent on Back.
      for (const ids of [
        {},
        { grant_id: "grant-1", request_id: "request-1" },
      ]) {
        const presented = presentFeedItem(
          feedItem(eventType, {
            ...metadata,
            ...ids,
            feed_audience: audience,
            counterpart_label: "Ankit",
          }),
        );
        expect(presented.href).toBe("/one/location?section=shared");
      }
    },
  );

  it.each(["owner", undefined])(
    "preserves outgoing and legacy %s destinations",
    (audience) => {
      const metadata = { feed_audience: audience, grant_id: "grant-1" };
      for (const event of [
        "location_share_created",
        "location_access_approved",
      ]) {
        expect(presentFeedItem(feedItem(event, metadata)).href).toBe(
          "/one/location",
        );
      }
      for (const event of [
        "location_share_shortened",
        "location_share_duration_changed",
      ]) {
        expect(presentFeedItem(feedItem(event, metadata)).href).toBe(
          "/one/location?grantId=grant-1&section=shared",
        );
      }
    },
  );

  it.each([
    "location_share_revoked",
    "location_share_expired",
    "location_access_denied",
  ])("preserves the terminal %s destination", (eventType) => {
    expect(
      presentFeedItem(feedItem(eventType, { feed_audience: "recipient" })).href,
    ).toBe("/one/location");
  });

  it.each([
    {
      eventType: "location_share_shortened",
      metadata: {
        counterpart_label: "Ankit",
        feed_audience: "recipient",
        reason: "owner_shorten",
        grant_id: "grant-1",
      },
      description: "Shortened your location access",
    },
    {
      eventType: "location_share_duration_changed",
      metadata: {
        counterpart_label: "Ankit",
        feed_audience: "recipient",
        direction: "extended",
        grant_id: "grant-1",
      },
      description: "Gave you more time",
    },
    {
      eventType: "location_access_request_withdrawn",
      metadata: {
        counterpart_label: "Ankit",
        feed_audience: "requester",
        request_id: "request-1",
      },
      description: "You took back your location request",
    },
    {
      eventType: "location_referral_invite",
      metadata: {
        counterpart_label: "Ankit",
        owner_label: "Meena",
        request_id: "request-1",
        referral_id: "referral-1",
      },
      description: "Referred you into a location request for Meena",
    },
    {
      eventType: "location_public_invite_submitted",
      metadata: {
        counterpart_label: "Visitor",
        public_location_view: false,
        submission_id: "submission-1",
      },
      description: "Requested location access from your public link",
    },
    {
      eventType: "location_one_network_joined",
      metadata: { counterpart_label: "Ankit" },
      description: "Joined your One Network",
    },
    {
      eventType: "location_circle_code_joined",
      metadata: {
        counterpart_label: "Ankit",
        circle_id: "circle-1",
        circle_name: "Family",
      },
      description: "Joined Family using your code",
    },
    {
      eventType: "location_circle_member_invite_accepted",
      metadata: {
        counterpart_label: "Ankit",
        circle_id: "circle-1",
        circle_name: "Family",
      },
      description: "Accepted your invitation and joined Family",
    },
  ])(
    "renders $eventType as actionable Feed history",
    ({ eventType, metadata, description }) => {
      const presented = presentFeedItem(feedItem(eventType, metadata));
      expect(presented.label).not.toBe("");
      expect(presented.description).toBe(description);
      expect(presented.href).toMatch(/^\/one\/location/);
    },
  );

  it.each([
    ["INCOMING", "completed", "Your deposit completed"],
    ["OUTGOING", "failed", "Your withdrawal failed"],
    ["INCOMING", "returned", "Your deposit was returned"],
    ["OUTGOING", "canceled", "Your withdrawal was canceled"],
  ])(
    "renders a privacy-bounded funding %s/%s transition",
    (direction, status, description) => {
      const presented = presentFeedItem(
        feedItem(
          "funding_transfer_status",
          {
            direction,
            user_facing_status: status,
            amount: "999999.99",
            failure_reason_message: "must never be rendered",
          },
          "kai",
        ),
      );
      expect(presented.label).toBe("Funding transfer");
      expect(presented.description).toBe(description);
      expect(presented.description).not.toContain("999999.99");
      expect(presented.description).not.toContain("must never be rendered");
      expect(presented.href).toMatch(/^\/one\/kai/);
    },
  );

  it("never promotes a raw phone field into plaintext Feed copy", () => {
    const presented = presentFeedItem(
      feedItem(
        "connection_accepted",
        { phone_number: "+1 555 010 1234" },
        "connections",
      ),
    );

    expect(presented.label).toBe("Connection");
    expect(`${presented.label} ${presented.description}`).not.toContain("555");
  });

  it("renders consent_granted feed event with granter profile link and navigation to shared section", () => {
    const presented = presentFeedItem(
      feedItem(
        "consent_granted",
        {
          granter_name: "Alice",
          scope_description: "Employment status",
          person_ref: "alice-public-ref",
        },
        "consent",
      ),
    );

    expect(presented.label).toBe("Information shared with you");
    expect(presented.description).toBe("Granted access to Employment status. Tap to view.");
    expect(presented.href).toBe("/people/alice-public-ref?section=shared");
  });

  it.each([
    ["calendar_connected", "Calendar", "/one/calendar"],
    ["calendar_reconnect_required", "Calendar", "/one/calendar"],
    ["calendar_disconnected", "Calendar", "/one/calendar"],
    ["calendar_event_created", "Calendar", "/one/calendar"],
    ["calendar_event_rescheduled", "Calendar", "/one/calendar"],
    ["calendar_event_canceled", "Calendar", "/one/calendar"],
    ["mail_connected", "Mail", "/one/gmail"],
    ["mail_reconnect_required", "Mail", "/one/gmail"],
    ["mail_disconnected", "Mail", "/one/gmail"],
    ["mail_information_request_detected", "Mail", "/one/gmail?workspace=kyc"],
    ["mail_receipts_imported", "Mail", "/one/gmail?workspace=receipts"],
    ["mail_sync_completed", "Mail", "/one/gmail?workspace=receipts"],
    ["mail_sync_failed", "Mail", "/one/gmail?workspace=receipts"],
    ["mail_message_sent", "Mail", "/one/gmail?workspace=kyc"],
    ["mail_message_failed", "Mail", "/one/gmail?workspace=kyc"],
    ["mail_delivery_unconfirmed", "Mail", "/one/gmail?workspace=kyc"],
  ])("renders %s as safe, actionable Feed history", (eventType, domain, href) => {
    const sensitive = "private-subject@example.com";
    const presented = presentFeedItem(
      feedItem(
        eventType,
        { subject: sensitive, email: sensitive, event_title: sensitive },
        "connected_systems",
      ),
    );
    expect(presented.domainLabel).toBe(domain);
    expect(presented.label).not.toBe("");
    expect(presented.description).not.toBe("");
    expect(`${presented.label} ${presented.description}`).not.toContain(sensitive);
    expect(presented.href).toBe(href);
  });
});

// Founder report (UAT): tapping "Analysis ready" opened the "Start debate"
// sheet, because the item linked to `?ticker=` -- the stock-preview route.
describe("Kai analysis ready Feed item", () => {
  const savedEntry: AnalysisHistoryEntry = {
    ticker: "NVDA",
    timestamp: "2026-09-27T10:00:00.000Z",
    decision: "hold",
    confidence: 0.6,
    consensus_reached: true,
    agent_votes: {},
    final_statement: "",
    raw_card: { debate_run_id: "run_abc" },
  };

  function openedAnalysisId(metadata: Record<string, unknown>): string | null {
    const href = presentFeedItem(feedItem("kai_analysis_completed", metadata, "kai")).href;
    const query = new URLSearchParams(href.split("?")[1] ?? "");
    // The stock preview (and its start sheet) opens only from `ticker`.
    expect(query.has("ticker")).toBe(false);
    return query.get("analysis_id");
  }

  it("opens the run's own saved result", () => {
    const analysisId = openedAnalysisId({ ticker: "NVDA", run_id: "run_abc" });
    expect(analysisId).not.toBeNull();
    expect(
      findAnalysisHistoryEntryByRouteId({ NVDA: [savedEntry] }, analysisId!),
    ).toBe(savedEntry);
    // A result that is gone resolves to nothing, which the analysis page shows
    // as "This analysis is no longer available" rather than a start sheet.
    expect(findAnalysisHistoryEntryByRouteId({}, analysisId!)).toBeNull();
  });

  it("sends older items without a run id to the analysis history", () => {
    expect(openedAnalysisId({ ticker: "NVDA" })).toBeNull();
  });
});
