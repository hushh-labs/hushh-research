import { describe, expect, it } from "vitest";

import { emptyStateCopy } from "@/components/consent/consent-center-view";

const VIEWS = ["pending", "active", "previous"] as const;
const ACTORS = ["investor", "ria"] as const;

describe("Consent Center empty state", () => {
  it("always gives a title and an orienting description", () => {
    for (const actor of ACTORS) {
      for (const view of VIEWS) {
        const copy = emptyStateCopy(actor, view);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.description.length).toBeGreaterThan(0);
        // The description must say what will appear in this space, so a
        // first-time visitor understands the promise instead of a blank list.
        expect(copy.description.toLowerCase()).toContain("here");
      }
    }
  });

  it("reads as reassurance, not as a cold absence", () => {
    // An empty consent centre is good news in a consent-first product:
    // nothing is waiting on you and nothing holds access it shouldn't.
    expect(emptyStateCopy("investor", "pending").title).toBe(
      "Nothing needs your approval",
    );
    expect(emptyStateCopy("investor", "active").title).toBe(
      "Nothing has access right now",
    );
    // The previous flat strings led with "No pending investor approvals or
    // developer requests yet." — a bare absence with no orientation.
    for (const actor of ACTORS) {
      for (const view of VIEWS) {
        expect(emptyStateCopy(actor, view).title).not.toMatch(
          /^No pending investor approvals/,
        );
      }
    }
  });

  it("tells each actor about their own side of the exchange", () => {
    expect(emptyStateCopy("ria", "pending").description).toContain("investor");
    expect(emptyStateCopy("investor", "pending").description).toContain(
      "asks for access",
    );
  });

  it("promises revocability where access is actually held", () => {
    // "You can end it at any time" is the consent-first guarantee; it must not
    // silently disappear from the active view.
    expect(emptyStateCopy("investor", "active").description).toContain(
      "end it at any time",
    );
  });

  it("keeps internal vocabulary out of the empty state", () => {
    for (const actor of ACTORS) {
      for (const view of VIEWS) {
        const { title, description } = emptyStateCopy(actor, view);
        const text = `${title} ${description}`;
        expect(text).not.toMatch(/scope code|consent ledger|PKM|grant_id/i);
      }
    }
  });
});
