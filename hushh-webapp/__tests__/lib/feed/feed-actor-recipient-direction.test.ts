import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * The Feed must always read relative to the person viewing it, never from
 * whichever display name happens to be attached to the row. Two accounts,
 * "Me" and "Jhumma", exchanging a location share: Me's row and Jhumma's row
 * describe the same event, but the sentence differs because the actor
 * differs.
 *
 * Bug: `location_share_created`'s owner row said "Started sharing location"
 * unconditionally -- paired with the recipient's name as the row title, that
 * read as the recipient having started the share, when the owner (the
 * viewer of that row) is always the actor for a direct share (see
 * one_location_agent_service.py's _insert_event call sites: actor_user_id is
 * always owner_user_id for this event type). This file is the direction
 * contract for every event type the Feed renders, so a future change can't
 * silently reintroduce the same class of bug on this or any other event.
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "location",
    event_type: "location_share_created",
    actor_label: null,
    metadata: {},
    read: false,
    created_at: "2026-08-19T06:27:00.000Z",
    ...overrides,
  };
}

describe("location_share_created", () => {
  it("Me shares my location with Jhumma: my row says I did it, names Jhumma", () => {
    // Owner's own row: no feed_audience marker at all (117/151's base
    // trigger writes it to owner_user_id, unmarked). actor_user_id is always
    // owner_user_id for this event type, so this row is always my own action.
    const presented = presentFeedItem(
      item({ metadata: { counterpart_label: "Jhumma Kumari" } }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe("You started sharing location");
  });

  it("names the duration when I started it with one", () => {
    const presented = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Jhumma Kumari",
          duration_hours: 4,
        },
      }),
    );
    expect(presented.description).toBe(
      "You started sharing location for 4 hours",
    );
  });

  it("Jhumma shares her location with me: my row says she did it, names Jhumma", () => {
    // Migration 152's recipient fan-out: feed_audience=recipient,
    // counterpart_label swapped to the OTHER person (the owner/actor).
    const presented = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Jhumma Kumari",
          feed_audience: "recipient",
          duration_hours: 4,
        },
      }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe(
      "Shared their location with you for 4 hours",
    );
  });

  it("never says the counterpart started it on my own row", () => {
    const mine = presentFeedItem(
      item({ metadata: { counterpart_label: "Jhumma Kumari" } }),
    );
    expect(mine.description).not.toMatch(/^Started sharing/);
    expect(mine.description).toContain("You");
  });
});

describe("location_share_revoked", () => {
  it("I stop sharing: my row says I stopped it", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: { counterpart_label: "Jhumma Kumari", reason: "owner_revoke" },
      }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe("You stopped sharing location");
  });

  it("Jhumma (the recipient) gives up her own access: my row says she stopped it", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: {
          counterpart_label: "Jhumma Kumari",
          reason: "recipient_revoke",
        },
      }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe("Stopped sharing location");
    expect(presented.description).not.toContain("You");
  });

  it("Jhumma's row (I revoked her access) says I stopped it, from her side", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: {
          counterpart_label: "Me",
          feed_audience: "recipient",
          reason: "owner_revoke",
        },
      }),
    );
    expect(presented.description).toBe("Stopped sharing their location");
  });

  it("Jhumma gives up her own access to my location: her row says SHE stopped it, not that I did", () => {
    // revoke_grant lets either party end a share -- the recipient can walk
    // away from their own access. That row belongs to Jhumma, tagged
    // feed_audience=recipient, and must say she acted, not that I (the
    // owner) did, even though counterpart_label still names me.
    const presented = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: {
          counterpart_label: "Me",
          feed_audience: "recipient",
          reason: "recipient_revoke",
        },
      }),
    );
    expect(presented.description).toBe("You stopped viewing their location");
    expect(presented.description).not.toContain("Stopped sharing their");
  });

  it("Jhumma's access ends because she rotated her own key: still her action, not mine", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: {
          counterpart_label: "Me",
          feed_audience: "recipient",
          reason: "recipient_key_rotated",
        },
      }),
    );
    expect(presented.description).toBe("You stopped viewing their location");
  });
});

describe("location_share_expired", () => {
  it("reads identically on both sides -- nobody is the actor, time just ran out", () => {
    const mine = presentFeedItem(
      item({
        event_type: "location_share_expired",
        metadata: { counterpart_label: "Jhumma Kumari" },
      }),
    );
    const theirs = presentFeedItem(
      item({
        event_type: "location_share_expired",
        metadata: { counterpart_label: "Me", feed_audience: "recipient" },
      }),
    );
    expect(mine.description).toBe("Stopped sharing - time ran out");
    expect(theirs.description).toBe("Stopped sharing - time ran out");
  });
});

describe("location_access_request", () => {
  it("I ask for Jhumma's location: my row says I asked", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_request",
        metadata: {
          counterpart_label: "Jhumma Kumari",
          feed_audience: "requester",
          requested_duration_hours: 1,
        },
      }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe(
      "You asked to see their location for 1 hour",
    );
  });

  it("Jhumma asks for mine: my row says she asked", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_request",
        metadata: {
          counterpart_label: "Jhumma Kumari",
          requested_duration_hours: 1,
        },
      }),
    );
    expect(presented.label).toBe("Jhumma Kumari");
    expect(presented.description).toBe("Requested your location for 1 hour");
    expect(presented.description).not.toContain("You");
  });
});

describe("location_access_approved", () => {
  it("I approve Jhumma's request: my row says I approved", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_approved",
        metadata: { counterpart_label: "Jhumma Kumari", duration_hours: 2 },
      }),
    );
    expect(presented.description).toBe("You approved 2 hours. Now sharing.");
  });

  it("Jhumma approves my request: my row says she gave me access, not that I approved", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_approved",
        metadata: {
          counterpart_label: "Jhumma Kumari",
          feed_audience: "requester",
        },
      }),
    );
    expect(presented.description).toBe("Approved your location request");
    expect(presented.description).not.toContain("You approved");
  });

  it("Jhumma gives me more time on a running share: names the amount from my side", () => {
    const presented = presentFeedItem(
      item({
        event_type: "location_access_approved",
        metadata: {
          counterpart_label: "Jhumma Kumari",
          feed_audience: "requester",
          is_extension: true,
          duration_hours: 2,
        },
      }),
    );
    expect(presented.description).toBe("Gave you 2 hours more");
  });
});

describe("connection_accepted / rejected / revoked", () => {
  const cases: Array<{
    event_type: FeedItem["event_type"];
    selfDescription: string;
    otherDescription: string;
  }> = [
    {
      event_type: "connection_accepted",
      selfDescription: "You accepted the connection request",
      otherDescription: "Accepted your connection request",
    },
    {
      event_type: "connection_rejected",
      selfDescription: "You declined the connection request",
      otherDescription: "Declined your connection request",
    },
    {
      event_type: "connection_revoked",
      selfDescription: "You removed the connection",
      otherDescription: "Removed your connection",
    },
  ];

  it.each(cases)(
    "$event_type: my row names the action from whichever side actually acted",
    ({ event_type, selfDescription, otherDescription }) => {
      // I accepted/declined/removed: actor_is_self is computed backend-side
      // from user IDs before either row is written (connections_service.py).
      const iActed = presentFeedItem(
        item({
          event_type,
          source_domain: "connections",
          metadata: { counterpart_label: "Jhumma Kumari", actor_is_self: true },
        }),
      );
      expect(iActed.label).toBe("Jhumma Kumari");
      expect(iActed.description).toBe(selfDescription);

      // Jhumma accepted/declined/removed: same event type, opposite actor.
      const theyActed = presentFeedItem(
        item({
          event_type,
          source_domain: "connections",
          metadata: { counterpart_label: "Jhumma Kumari", actor_is_self: false },
        }),
      );
      expect(theyActed.label).toBe("Jhumma Kumari");
      expect(theyActed.description).toBe(otherDescription);

      // Never the same sentence for opposite actors.
      expect(iActed.description).not.toBe(theyActed.description);
    },
  );
});
