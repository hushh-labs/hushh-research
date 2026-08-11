// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearActionUsage,
  readActionUsage,
  recordActionUse,
  usageBoostFor,
} from "@/lib/voice/action-usage-memory";

const USER = "user_1";
const DAY = 1000 * 60 * 60 * 24;

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("what the palette remembers", () => {
  it("keeps habits apart per account", () => {
    // A shared device must not blend one person's habits into another's
    // suggestions.
    recordActionUse(USER, "location.open_share");
    recordActionUse("user_2", "analysis.start");

    expect(readActionUsage(USER).map((entry) => entry.actionId)).toEqual([
      "location.open_share",
    ]);
    expect(readActionUsage("user_2").map((entry) => entry.actionId)).toEqual([
      "analysis.start",
    ]);
  });

  it("records nothing without an account", () => {
    recordActionUse(null, "location.open_share");
    recordActionUse("", "location.open_share");

    expect(readActionUsage(null)).toEqual([]);
  });

  it("puts a daily habit above a one-off burst", () => {
    // Frequency alone entrenches last month's spike; recency alone forgets the
    // thing you do every morning. This is the case that separates them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    for (let i = 0; i < 6; i += 1) recordActionUse(USER, "analysis.start");

    vi.setSystemTime(new Date("2026-02-05T09:00:00Z"));
    for (let i = 0; i < 3; i += 1) recordActionUse(USER, "location.open_share");

    expect(readActionUsage(USER)[0].actionId).toBe("location.open_share");
  });

  it("forgets something used once, long ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    recordActionUse(USER, "kai.setup.answer_horizon");

    // Beyond the horizon: importing a portfolio once in March should not still
    // be suggested in August.
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z").getTime() + 60 * DAY);
    expect(readActionUsage(USER)).toEqual([]);
  });

  it("survives corrupt storage rather than throwing", () => {
    window.localStorage.setItem("hushh.action-usage.v1.user_1", "{not json");
    expect(readActionUsage(USER)).toEqual([]);

    window.localStorage.setItem("hushh.action-usage.v1.user_1", '[{"nope":1}]');
    expect(readActionUsage(USER)).toEqual([]);
  });
});

describe("how much habit is allowed to matter", () => {
  it("is a tie-break, never a way to outrank a better answer", () => {
    for (let i = 0; i < 500; i += 1) recordActionUse(USER, "analysis.start");

    // Capped well below the gap `scoreSearchMatch` puts between a label match
    // (+8) and a keyword match (+4), so typing "circle" still finds Create a
    // circle however often you have analysed a stock.
    expect(usageBoostFor(readActionUsage(USER), "analysis.start")).toBeLessThanOrEqual(3);
  });

  it("is nothing at all for something never used", () => {
    recordActionUse(USER, "analysis.start");
    expect(
      usageBoostFor(readActionUsage(USER), "location.open_join_circle"),
    ).toBe(0);
  });
});

describe("forgetting on request", () => {
  it("clears one account without touching another", () => {
    recordActionUse(USER, "location.open_share");
    recordActionUse("user_2", "analysis.start");

    clearActionUsage(USER);

    expect(readActionUsage(USER)).toEqual([]);
    expect(readActionUsage("user_2")).toHaveLength(1);
  });
});
