import { describe, expect, it } from "vitest";

import {
  APPROVE_SHORTER_MAX_OPTIONS,
  approveShorterDurationOptions,
} from "@/lib/one-location/approve-duration-options";

/**
 * Reported: "i received access req for 4 hours from unknown, i can either
 * accept with same duration or deny ... if i want to edit the time, and want
 * to approve req for shorter duration i am not allowed to do so".
 */

function ask(
  hours: number | null,
  mode: "timed" | "until_stopped" = "timed",
) {
  return { requestedDurationHours: hours, requestedDurationMode: mode };
}

describe("approveShorterDurationOptions", () => {
  it("offers every standard length below a four-hour ask", () => {
    // The reported case. Four answers, not the one hard-coded "Allow 1 hour"
    // the card used to carry.
    expect(approveShorterDurationOptions(ask(4)).map((o) => o.label)).toEqual([
      "15 min",
      "30 min",
      "1 hour",
      "2 hours",
    ]);
  });

  it("never offers as much as, or more than, was asked", () => {
    // The rule the whole module exists for. Approving MORE than a request
    // named would publish the owner's location past the window anybody asked
    // for, from the screen whose job is answering somebody else's question.
    for (const hours of [0.25, 0.5, 1, 2, 4, 8, 24]) {
      const offered = approveShorterDurationOptions(ask(hours));
      expect(
        offered.every((option) => option.hours < hours),
        `an option was >= the ${hours}h ask`,
      ).toBe(true);
    }
  });

  it("has nothing shorter to offer at the floor", () => {
    // 15 minutes is `MIN_DURATION_HOURS`. There is no smaller answer than the
    // smallest thing anyone can ask for, so the card shows no row at all
    // rather than an empty one.
    expect(approveShorterDurationOptions(ask(0.25))).toEqual([]);
  });

  it("treats an open-ended ask as having no ceiling", () => {
    // The case where choosing matters most: the alternative to naming an
    // amount is agreeing to be visible with no end at all.
    const offered = approveShorterDurationOptions(ask(null, "until_stopped"));
    expect(offered.length).toBe(APPROVE_SHORTER_MAX_OPTIONS);
    expect(offered.map((o) => o.label)).toEqual([
      "30 min",
      "1 hour",
      "2 hours",
      "4 hours",
    ]);
  });

  it("keeps the longest when more qualify than fit", () => {
    // Somebody negotiating an eight-hour ask down is reaching for "an hour or
    // two", not for the floor -- and a card that grows a row per rung stops
    // being a decision and starts being a form.
    const offered = approveShorterDurationOptions(ask(8));
    expect(offered).toHaveLength(APPROVE_SHORTER_MAX_OPTIONS);
    expect(offered.map((o) => o.label)).toEqual([
      "30 min",
      "1 hour",
      "2 hours",
      "4 hours",
    ]);
  });

  it("offers nothing when the ask carries no readable amount", () => {
    // An older client or a referral request. There is nothing to be shorter
    // THAN, and guessing a ceiling would offer a "less" that might be more.
    expect(approveShorterDurationOptions(ask(null))).toEqual([]);
    expect(approveShorterDurationOptions(ask(0))).toEqual([]);
    expect(
      approveShorterDurationOptions({
        requestedDurationHours: Number.NaN,
        requestedDurationMode: "timed",
      }),
    ).toEqual([]);
  });

  it("labels minutes as minutes and hours as hours", () => {
    expect(approveShorterDurationOptions(ask(2)).map((o) => o.label)).toEqual([
      "15 min",
      "30 min",
      "1 hour",
    ]);
  });
});
