import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * "Did they actually look?"
 *
 * It is the question a person asks after sharing their location, and the Feed
 * could not answer it. `location_share_viewed` has been written on every
 * envelope read since the feature shipped -- it reaches the audit ledger and
 * the in-app Activity list -- but no trigger ever projected it, so it never
 * reached either Feed.
 *
 * Only the OWNER gets this row. "You viewed their location" is not news to the
 * person who did the viewing, and writing it would put a recipient's own
 * polling back into their own Feed.
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "location",
    event_type: "location_share_viewed",
    actor_label: "Ankit",
    metadata: { counterpart_label: "Ankit" },
    read: false,
    created_at: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("the owner is told who looked", () => {
  it("names the viewer and says what they did", () => {
    const line = presentFeedItem(item());
    expect(line.label).toBe("Ankit");
    expect(line.description).toBe("Saw your location");
  });

  it("still renders when the backend could not resolve a name", () => {
    const line = presentFeedItem(item({ metadata: {} }));
    expect(line.label).toBe("Location");
    expect(line.description).toBe("Saw your location");
  });

  it("opens One Location", () => {
    expect(presentFeedItem(item()).href).toBeTruthy();
  });

  it("fits on one line", () => {
    // ~30 characters is the description column at 375px.
    expect(presentFeedItem(item()).description.length).toBeLessThanOrEqual(30);
  });

  it("does not borrow the share lifecycle's wording", () => {
    // A view is not a share starting, stopping or expiring. Reusing any of
    // those lines would report an ordinary read as a state change.
    const line = presentFeedItem(item()).description;
    for (const other of [
      "You started sharing location",
      "Shared location with you",
      "Sharing stopped",
      "Ended when time ran out",
    ]) {
      expect(line).not.toBe(other);
    }
  });
});
