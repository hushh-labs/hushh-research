import { describe, expect, it } from "vitest";

import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * A consent row names what was shared in words. On the phone (2026-09-22)
 * the Feed printed the stored key itself:
 * "attr.professional.work_preferences.entities._entities.observations._items
 * was revoked."
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "consent",
    event_type: "consent_revoked",
    actor_label: null,
    metadata: {},
    read: false,
    created_at: "2026-09-22T15:29:00.000Z",
    ...overrides,
  } as FeedItem;
}

describe("consent scope wording", () => {
  it("drops the memory's structural segments", () => {
    expect(
      humanizeConsentScope("attr.professional.work_preferences.entities._entities.observations._items"),
    ).toBe("Professional Work Preferences Observations");
    expect(humanizeConsentScope("attr.location.saved_places.locations._items.longitude")).toBe(
      "Location Saved Places Locations Longitude",
    );
  });

  it("keeps the wording the rest of the app already relies on", () => {
    expect(humanizeConsentScope("attr.identity.email")).toBe("Identity Mail");
    expect(humanizeConsentScope("attr.financial.*")).toBe("Financial data");
    expect(humanizeConsentScope("attr.financial._items")).toBe("Financial data");
    expect(humanizeConsentScope("vault.owner")).toBe("Full vault access");
  });

  it("never prints a raw scope key in a Feed row", () => {
    const scope = "attr.professional.profile.entities._entities.summary";
    const row = presentFeedItem(item({ metadata: { scope } }));
    expect(row.description).toBe("You stopped sharing your Professional profile summary");
    expect(row.description).not.toContain("attr.");
    expect(row.description).not.toContain("_entities");
  });

  // Measured on UAT 2026-09-28: the request read "Preferences" (its stored
  // description) and the access it became read "Food Preferences" (its key),
  // because only one of them carried a description. The key is on every row,
  // so naming from it is the one rule that makes the two agree.
  it("names the item from its key so a request and its access agree", () => {
    const requested = presentFeedItem(
      item({
        event_type: "consent_requested",
        metadata: { scope: "attr.food.preferences.*", scope_description: "Preferences" },
      }),
    );
    const revoked = presentFeedItem(
      item({ metadata: { scope: "attr.food.preferences.*" } }),
    );
    expect(requested.description).toBe("Someone asked for your Food preferences");
    expect(revoked.description).toBe("You stopped sharing your Food preferences");
  });

  it("falls back to the stored name when a row has no key", () => {
    const row = presentFeedItem(
      item({ metadata: { scope_description: "Your work email" } }),
    );
    expect(row.description).toBe("You stopped sharing your Work email");
  });
});
