import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Nobody becomes an emergency contact in silence.
 *
 * Being on a person's SMS Circle is the list that receives their Save my Soul
 * alert, so membership decides whether an emergency reaches you at all. It was
 * also the only relationship One Location changed with no announcement of any
 * kind: `add_sms_contact` was a lock plus an INSERT and `remove_sms_contact` a
 * bare DELETE -- no event, no Feed row, no push, on either side. The only
 * feedback anywhere was a toast on the adder's own device, so the person taking
 * on the duty was never told they had it, and the person losing it never
 * learned the alert they expected would not arrive.
 *
 * Both sides now get a row. The emission and the both-audience projection are
 * covered in `test_one_location_agent_service.py`; this covers what each side
 * reads.
 */

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed_1",
    source_domain: "location",
    event_type: "location_sms_contact_added",
    actor_label: null,
    metadata: { counterpart_label: "Ankit" },
    read: false,
    created_at: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

const owner = { counterpart_label: "Ankit" };
const contact = { counterpart_label: "Neelesh", feed_audience: "recipient" };

describe("SMS Circle membership reaches both people", () => {
  it("tells the owner who they added", () => {
    expect(presentFeedItem(item({ metadata: owner })).description).toBe(
      "Added to your SMS Circle",
    );
  });

  it("tells the contact they were added", () => {
    // The whole point: this row is the only way they find out.
    expect(presentFeedItem(item({ metadata: contact })).description).toBe(
      "Added you to SMS Circle",
    );
  });

  it("tells the owner who they removed", () => {
    expect(
      presentFeedItem(
        item({ event_type: "location_sms_contact_removed", metadata: owner }),
      ).description,
    ).toBe("Removed from your SMS");
  });

  it("tells the contact they were removed", () => {
    // Losing the duty matters as much as gaining it: without this they keep
    // expecting an alert that will never come.
    expect(
      presentFeedItem(
        item({ event_type: "location_sms_contact_removed", metadata: contact }),
      ).description,
    ).toBe("Removed you from SMS Circle");
  });

  it("names the other person as the row's title, on both sides", () => {
    expect(presentFeedItem(item({ metadata: owner })).label).toBe("Ankit");
    expect(presentFeedItem(item({ metadata: contact })).label).toBe("Neelesh");
  });

  it("never confuses the two sides", () => {
    for (const event_type of [
      "location_sms_contact_added",
      "location_sms_contact_removed",
    ] as const) {
      const a = presentFeedItem(item({ event_type, metadata: owner }));
      const b = presentFeedItem(item({ event_type, metadata: contact }));
      expect(a.description).not.toBe(b.description);
    }
  });

  it("never puts a possessive pronoun next to the name on the row", () => {
    // The row's title is already the other person, so "added you to THEIR SMS"
    // reads as a name followed immediately by a pronoun for that same name.
    // Dropping the pronoun is shorter and says exactly as much.
    for (const event_type of [
      "location_sms_contact_added",
      "location_sms_contact_removed",
    ] as const) {
      for (const metadata of [owner, contact]) {
        const line = presentFeedItem(item({ event_type, metadata })).description;
        expect(line).not.toMatch(/their/i);
      }
    }
  });

  it("says SMS, never SOS, and fits on one line", () => {
    for (const event_type of [
      "location_sms_contact_added",
      "location_sms_contact_removed",
    ] as const) {
      for (const metadata of [owner, contact]) {
        const line = presentFeedItem(item({ event_type, metadata })).description;
        expect(line).toMatch(/SMS/);
        expect(line).not.toMatch(/SOS/i);
        // ~30 characters is the description column at 375px.
        expect(line.length, `"${line}" is ${line.length} characters`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("still renders when the backend could not resolve a name", () => {
    const line = presentFeedItem(item({ metadata: {} }));
    expect(line.label).toBe("Location");
    expect(line.description).toBe("Added to your SMS Circle");
  });
});
