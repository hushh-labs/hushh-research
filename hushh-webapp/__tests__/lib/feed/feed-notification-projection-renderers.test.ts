import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

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
});
