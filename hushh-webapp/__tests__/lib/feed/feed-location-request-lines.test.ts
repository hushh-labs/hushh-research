import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Feed lines for the request lifecycle.
 *
 * Two things were missing. The AMOUNT: "Requested your location" said something
 * happened, not what, so a person asking to extend by three hours read
 * identically to one asking for fifteen minutes. And the OTHER SIDE: the fan-out
 * was owner-scoped, so the person who did the asking could read the exchange
 * nowhere at all -- not the ask, not the answer, only a toast that is gone the
 * moment it is dismissed.
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "location",
    event_type: "location_access_request",
    actor_label: null,
    metadata: { counterpart_label: "Ankit" },
    read: false,
    created_at: "2026-08-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("the owner's side of the exchange", () => {
  it("names the extra time asked for", () => {
    const presented = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Ankit",
                    is_extension: true,
          requested_duration_hours: 3,
        },
      }),
    );
    expect(presented.label).toBe("Ankit");
    expect(presented.description).toBe("Asked for 3 hours more");
  });

  it("names the duration on a fresh ask too", () => {
    const presented = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Ankit",
                    requested_duration_hours: 0.5,
        },
      }),
    );
    expect(presented.description).toBe("Requested your location for 30 min");
  });

  it("says how much time it gave, not just that it approved", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_approved",
        metadata: {
          counterpart_label: "Ankit",
                    is_extension: true,
          duration_hours: 4,
        },
      }),
    );
    expect(presented.description).toBe("You gave them 4 hours more");
  });

  it("distinguishes declining extra time from declining access outright", () => {
    expect(
      presentFeedItem(
        item({
          event_type: "location_access_denied",
          metadata: { counterpart_label: "Ankit", is_extension: true },
        }),
      ).description,
    ).toBe("You declined the extra time");
    expect(
      presentFeedItem(
        item({
          event_type: "location_access_denied",
          metadata: { counterpart_label: "Ankit" },
        }),
      ).description,
    ).toBe("You declined the location request");
  });
});

describe("the requester's side of the same exchange", () => {
  it("reads as their own action, not as something done to them", () => {
    const presented = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Neelesh",
          feed_audience: "requester",
          is_extension: true,
          requested_duration_hours: 3,
        },
      }),
    );
    // The fan-out swaps counterpart_label to the OTHER person, so neither side
    // reads its own name back as the actor. The marker is `feed_audience`,
    // shared with migration 152 rather than a second parallel convention.
    expect(presented.label).toBe("Neelesh");
    expect(presented.description).toBe("You asked for 3 hours more");
    expect(presented.href).toContain("section=my_requests");
  });

  it("tells them how much they were actually given, on the share row", () => {
    // The approval itself is NOT fanned out to the requester -- 152 already
    // writes them the share row it produced, and adding a second would give
    // one person two rows for one tap. That surviving row names the amount.
    const presented = presentFeedItem(
      item({
        event_type: "location_share_created",
        metadata: {
          counterpart_label: "Neelesh",
          feed_audience: "recipient",
          duration_hours: 4,
        },
      }),
    );
    expect(presented.description).toBe(
      "Shared location with you for 4 hours",
    );
  });

  it("makes owner-side share rows clear", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_share_created",
        metadata: {
          counterpart_label: "Abdul Rashid",
        },
      }),
    );
    expect(presented.label).toBe("Abdul Rashid");
    expect(presented.description).toBe("You started sharing location");
  });

  it("says a refused extension leaves current access alone", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_denied",
        metadata: {
          counterpart_label: "Neelesh",
          feed_audience: "requester",
          is_extension: true,
        },
      }),
    );
    // Read as a bare "declined", it looks like everything just stopped.
    expect(presented.description).toBe(
      "Declined the extra time — your current access is unchanged",
    );
  });
});

describe("rows written before any of this existed", () => {
  it("keeps the owner wording they were written for", () => {
    // No feed_audience marker and no duration: the old copy is still the true copy.
    expect(presentFeedItem(item()).description).toBe("Requested your location");
    // Migration 151 stopped forwarding the approval-born share row, so this
    // line is now the only report of that whole tap and has to say the share
    // started -- not merely that a request was answered.
    expect(
      presentFeedItem(item({ event_type: "location_access_approved" }))
        .description,
    ).toBe("You approved. Now sharing.");
  });
});

describe("shortening", () => {
  it("has a line at all now that the event can be recorded", () => {
    // shorten_grant has always inserted location_share_shortened, but the event
    // type was missing from the table's CHECK, so every insert failed and was
    // swallowed as a warning. With the row insertable, the feed needs a line
    // for it rather than the generic "Something happened in your account."
    expect(
      presentFeedItem(
        item({
          event_type: "location_share_shortened",
          metadata: { counterpart_label: "Ankit", reason: "owner_shorten" },
        }),
      ).description,
    ).toBe("You shortened location access");
    expect(
      presentFeedItem(
        item({
          event_type: "location_share_shortened",
          metadata: { counterpart_label: "Ankit", reason: "recipient_shorten" },
        }),
      ).description,
    ).toBe("Gave back remaining time early");
  });
});
