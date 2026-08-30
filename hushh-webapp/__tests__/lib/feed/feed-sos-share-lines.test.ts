import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * An SOS must not read as an ordinary share.
 *
 * Receiving an emergency alert produced "Shared location with you", then
 * "Stopped sharing location" -- the same two lines a routine share writes. On
 * the one screen a person scans to find out what needs them, an emergency was
 * indistinguishable from someone sharing their location for an hour.
 *
 * The cause was not the copy. `share_kind` -- the only field separating the SOS
 * lane from everything else -- was missing from the feed metadata allowlist in
 * feed_service.py, so it never reached the client and the distinction could not
 * be drawn at all. These tests cover the rendering half; the allowlist half is
 * what makes the metadata arrive.
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

describe("an SOS share reads as an emergency, not a share", () => {
  it("names the emergency when one arrives", () => {
    const line = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Ankit",
          share_kind: "sos",
          feed_audience: "recipient",
        },
      }),
    );
    expect(line.description).toMatch(/SOS/i);
    expect(line.description).not.toBe("Shared location with you");
  });

  it("names the emergency when it ends, rather than 'stopped sharing'", () => {
    const line = presentFeedItem(
      item({
        event_type: "location_share_revoked",
        metadata: {
          counterpart_label: "Ankit",
          share_kind: "sos",
          feed_audience: "recipient",
        },
      }),
    );
    expect(line.description).toMatch(/SOS/i);
    expect(line.description).not.toBe("Stopped sharing location");
  });

  it("names the emergency when it times out", () => {
    const line = presentFeedItem(
      item({
        event_type: "location_share_expired",
        metadata: { counterpart_label: "Ankit", share_kind: "sos" },
      }),
    );
    expect(line.description).toMatch(/SOS/i);
  });

  it("leaves an ordinary share untouched", () => {
    // The regression guard that matters most: SOS wording must not leak onto
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

  it("still tells the two sides apart for an SOS", () => {
    // The owner sent it; the recipient received it. Collapsing that would put
    // "sent an SOS" in front of the person who was alerted.
    const owner = presentFeedItem(
      item({ metadata: { counterpart_label: "Ankit", share_kind: "sos" } }),
    );
    const recipient = presentFeedItem(
      item({
        metadata: {
          counterpart_label: "Ankit",
          share_kind: "sos",
          feed_audience: "recipient",
        },
      }),
    );
    expect(owner.description).not.toBe(recipient.description);
  });
});
