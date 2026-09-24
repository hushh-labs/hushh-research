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
    expect(row.description).toBe("Professional Profile Summary was revoked.");
    expect(row.description).not.toContain("attr.");
    expect(row.description).not.toContain("_entities");
  });

  it("prefers the stored description when there is one", () => {
    const row = presentFeedItem(
      item({ metadata: { scope: "attr.identity.email", scope_description: "Your work email" } }),
    );
    expect(row.description).toBe("Your work email was revoked.");
  });
});
