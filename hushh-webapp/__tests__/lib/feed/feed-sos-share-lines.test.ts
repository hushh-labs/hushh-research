import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * An SMS must not read as an ordinary share.
 *
 * SMS is this product's own name for the emergency lane -- Save my Soul -- not
 * the carrier's; no text message is sent anywhere in the flow. "SOS" is the
 * server's word for the same lane (`share_kind === "sos"`, the `?action=sos`
 * slug) and it stays on the wire, where renaming it would invalidate stored
 * grants and deep links. What a person is SHOWN is SMS, everywhere. That rule
 * is already enforced for notification copy by
 * `one-location-sms-revoke-notification.test.ts`; these tests extend it to the
 * Feed, which was the one surface still saying "emergency SOS".
 *
 * QA, from TestFlight: sending an SMS to a connection and stopping it produced
 * "You started sharing location" then "You stopped sharing location" -- the two
 * lines an ordinary share writes. `share_kind` is the only field that separates
 * the lanes, and although it was allowlisted into the Feed payload and read
 * here, NOTHING WROTE IT: all three `location_share_created` emitters and the
 * expiry sweep built their metadata by hand without it, and both projection
 * triggers in migration 179 dropped it again. Constructing metadata by hand --
 * as the tests below must -- is exactly why that gap survived, so the emission
 * itself is covered separately in
 * `consent-protocol/tests/test_one_location_feed_share_kind_emission.py`.
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "location",
    event_type: "location_share_created",
    actor_label: null,
    metadata: { counterpart_label: "Ankit" },
    read: false,
    created_at: "2026-08-16T12:00:00.000Z",
    ...overrides,
  };
}

const owner = (extra: Record<string, unknown> = {}) => ({
  counterpart_label: "Ankit",
  share_kind: "sos",
  ...extra,
});
const recipient = (extra: Record<string, unknown> = {}) => ({
  ...owner(extra),
  feed_audience: "recipient",
});

describe("an SMS share reads as an emergency, not a share", () => {
  it("names it on the sender's own Feed when it starts", () => {
    expect(presentFeedItem(item({ metadata: owner() })).description).toBe(
      "You sent an SMS",
    );
  });

  it("names it on the recipient's Feed when it arrives", () => {
    expect(presentFeedItem(item({ metadata: recipient() })).description).toBe(
      "Sent you an SMS",
    );
  });

  it("keeps the amount when the recipient's row carries one", () => {
    const line = presentFeedItem(
      item({ metadata: recipient({ duration_hours: 3 }) }),
    );
    expect(line.description).toBe("SMS for 3 hours");
  });

  it("names it when it ends, rather than 'stopped sharing'", () => {
    expect(
      presentFeedItem(
        item({ event_type: "location_share_revoked", metadata: owner() }),
      ).description,
    ).toBe("You ended your SMS");
    expect(
      presentFeedItem(
        item({ event_type: "location_share_revoked", metadata: recipient() }),
      ).description,
    ).toBe("SMS ended");
  });

  it("names it when it times out", () => {
    expect(
      presentFeedItem(
        item({ event_type: "location_share_expired", metadata: owner() }),
      ).description,
    ).toBe("SMS ran out of time");
  });

  it("never says SOS to a person, on any side or any transition", () => {
    // The whole point of the rename. A single leak puts the server's word in
    // front of a reader who has only ever been shown "SMS".
    for (const event_type of [
      "location_share_created",
      "location_share_revoked",
      "location_share_expired",
    ] as const) {
      for (const metadata of [owner(), recipient(), owner({ duration_hours: 3 })]) {
        const line = presentFeedItem(item({ event_type, metadata }));
        expect(line.description, `${event_type}`).not.toMatch(/SOS/i);
        expect(line.description).toMatch(/SMS/);
      }
    }
  });

  it("keeps every emergency line short enough to read on one row", () => {
    // QA: "SMS sent in one line nahi". The description column is ~197px at
    // 375px -- roughly 30 characters of 13px Inter -- and anything longer
    // wraps or clips. These lines are the ones a person reads while deciding
    // whether something needs them, so they are the ones that must not wrap.
    const lines = [
      presentFeedItem(item({ metadata: owner() })).description,
      presentFeedItem(item({ metadata: recipient() })).description,
      presentFeedItem(item({ metadata: recipient({ duration_hours: 3 }) }))
        .description,
      presentFeedItem(
        item({ event_type: "location_share_revoked", metadata: owner() }),
      ).description,
      presentFeedItem(
        item({ event_type: "location_share_revoked", metadata: recipient() }),
      ).description,
      presentFeedItem(
        item({ event_type: "location_share_expired", metadata: owner() }),
      ).description,
      presentFeedItem(
        item({ event_type: "location_share_expired", metadata: {} }),
      ).description,
    ];
    for (const line of lines) {
      expect(line.length, `"${line}" is ${line.length} characters`).toBeLessThanOrEqual(30);
    }
  });

  it("leaves an ordinary share untouched", () => {
    // The regression guard that matters most: SMS wording must not leak onto
    // every share. Absent `share_kind`, and for any other lane, the existing
    // lines stay exactly as they were.
    for (const metadata of [
      { counterpart_label: "Ankit", feed_audience: "recipient" },
      {
        counterpart_label: "Ankit",
        feed_audience: "recipient",
        share_kind: "check_in",
      },
    ]) {
      const created = presentFeedItem(item({ metadata }));
      expect(created.description).toBe("Shared location with you");
      const revoked = presentFeedItem(
        item({ event_type: "location_share_revoked", metadata }),
      );
      expect(revoked.description).toBe("Sharing stopped");
    }
  });

  it("still tells the two sides apart", () => {
    // The owner sent it; the recipient received it. Collapsing that would put
    // "you sent" in front of the person who was alerted.
    expect(presentFeedItem(item({ metadata: owner() })).description).not.toBe(
      presentFeedItem(item({ metadata: recipient() })).description,
    );
  });
});
