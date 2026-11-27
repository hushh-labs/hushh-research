/**
 * "Renewal increases by ₹600" is two validated amounts and their difference,
 * nothing more. A finding that cannot be stated exactly says nothing.
 */

import { describe, expect, it } from "vitest";

import type { NoticeFinding } from "@/lib/mail/receipt-notice";
import { receiptPriceUpdate } from "@/lib/mail/receipt-price-update";

function finding(over: Partial<NoticeFinding> & { facts?: NoticeFinding["facts"] } = {}): NoticeFinding {
  return {
    id: "f_price_1",
    kind: "price_rise",
    headline: "Netflix is going up",
    reason: "Netflix announced a new price.",
    strength: "clear",
    provider: { name: "Netflix", domain: "netflix.com" },
    action: { id: "review_bill", label: "Review bill" },
    evidence: [],
    plans: [],
    attribution: null,
    score: 1,
    generatedAt: "2026-11-25T10:00:00Z",
    ...over,
    facts: {
      currency: "INR",
      last_paid_minor: 120_000,
      new_minor: 180_000,
      new_is_announced: true,
      base_minor: 120_000,
      base_kind: "median_of_last_three",
      percent: "50.0",
      effective_on: "2026-11-26",
      ...(over.facts ?? {}),
    },
  };
}

describe("an announced renewal", () => {
  it("is the rise from what was paid to what will be charged, with the date the provider gave", () => {
    const update = receiptPriceUpdate(finding());

    expect(update).toEqual({
      findingId: "f_price_1",
      title: "Netflix renewal increases by ₹600",
      line: "You paid ₹1,200. The 26 Nov renewal is ₹1,800.",
    });
  });

  it("does not invent a date the provider did not state", () => {
    const update = receiptPriceUpdate(finding({ facts: { effective_on: null } }));
    expect(update?.line).toBe("You paid ₹1,200. The next renewal is ₹1,800.");
  });

  it("works without a provider name", () => {
    expect(receiptPriceUpdate(finding({ provider: null }))?.title).toBe("Renewal increases by ₹600");
  });
});

describe("a bill that came out higher", () => {
  it("says what the latest bill was and what it was before, and never calls it an announcement", () => {
    const update = receiptPriceUpdate(finding({ facts: { new_is_announced: false } }));
    expect(update).toMatchObject({
      title: "Netflix bill rose by ₹600",
      line: "Your latest bill is ₹1,800, up from ₹1,200.",
    });
  });
});

describe("what is left unsaid", () => {
  it("returns nothing when a number is missing, not a rise, or not a whole amount", () => {
    for (const facts of [
      { last_paid_minor: null },
      { new_minor: 0 },
      { new_minor: 120_000 }, // the same
      { new_minor: 100_000 }, // lower
      { new_minor: 180_000.5 },
      { currency: "" },
    ] as Array<NoticeFinding["facts"]>) {
      expect(receiptPriceUpdate(finding({ facts }))).toBeNull();
    }
  });

  it("belongs only to a price rise", () => {
    for (const kind of ["plan_review", "inactive_plan", "refund_followup", "possible_duplicate"] as const) {
      expect(receiptPriceUpdate(finding({ kind }))).toBeNull();
    }
  });
});
