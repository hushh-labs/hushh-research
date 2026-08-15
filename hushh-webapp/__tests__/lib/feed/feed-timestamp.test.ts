import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daysSinceToday, formatFeedTimestamp } from "@/lib/feed/feed-timestamp";

describe("formatFeedTimestamp", () => {
  beforeEach(() => {
    // Pinned "now": Wed, 2026-08-12 15:45 local time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 12, 15, 45, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AM/PM casing is locale-dependent (this codebase deliberately delegates
  // locale resolution to the runtime, see local-date-time.ts) — assert the
  // digits/day-prefix exactly and match am/pm case-insensitively.
  it("labels a same-day instant as Today, 12-hour clock", () => {
    const sameDay = new Date(2026, 7, 12, 15, 45, 0);
    expect(formatFeedTimestamp(sameDay)).toMatch(/^Today - 3:45\s?PM$/i);
  });

  it("labels the previous calendar day as Yesterday", () => {
    const yesterday = new Date(2026, 7, 11, 9, 5, 0);
    expect(formatFeedTimestamp(yesterday)).toMatch(/^Yesterday - 9:05\s?AM$/i);
  });

  it("labels anything older with a short weekday", () => {
    const older = new Date(2026, 7, 10, 18, 30, 0); // Mon
    expect(formatFeedTimestamp(older)).toMatch(/^Mon - 6:30\s?PM$/i);
  });

  it("always renders 12-hour time, never 24-hour", () => {
    const afternoon = new Date(2026, 7, 12, 15, 45, 0); // 15:45 local
    const label = formatFeedTimestamp(afternoon);
    expect(label).toMatch(/3:45\s?PM/i);
    expect(label).not.toContain("15:45");
  });

  it("formats noon and midnight correctly", () => {
    expect(formatFeedTimestamp(new Date(2026, 7, 12, 12, 0, 0))).toMatch(
      /^Today - 12:00\s?PM$/i,
    );
    expect(formatFeedTimestamp(new Date(2026, 7, 12, 0, 0, 0))).toMatch(
      /^Today - 12:00\s?AM$/i,
    );
  });

  it("returns an empty string for an invalid or missing instant", () => {
    expect(formatFeedTimestamp("not-a-date")).toBe("");
    expect(formatFeedTimestamp(Number.NaN)).toBe("");
  });

  it("produces identical output for Date, ISO string, and epoch-number inputs", () => {
    const instant = new Date(2026, 7, 12, 15, 45, 0);
    const fromDate = formatFeedTimestamp(instant);
    const fromIso = formatFeedTimestamp(instant.toISOString());
    const fromEpoch = formatFeedTimestamp(instant.getTime());
    expect(fromIso).toBe(fromDate);
    expect(fromEpoch).toBe(fromDate);
  });
});

describe("daysSinceToday", () => {
  it("returns 0 for the same calendar day even across different times", () => {
    const now = new Date(2026, 7, 12, 23, 59, 0);
    const earlierSameDay = new Date(2026, 7, 12, 0, 1, 0);
    expect(daysSinceToday(earlierSameDay, now)).toBe(0);
  });

  it("returns 1 across a local-midnight boundary just before/after it", () => {
    const now = new Date(2026, 7, 12, 0, 1, 0);
    const justBeforeMidnight = new Date(2026, 7, 11, 23, 59, 0);
    expect(daysSinceToday(justBeforeMidnight, now)).toBe(1);
  });

  it("returns negative values for a future date", () => {
    const now = new Date(2026, 7, 12, 12, 0, 0);
    const tomorrow = new Date(2026, 7, 13, 12, 0, 0);
    expect(daysSinceToday(tomorrow, now)).toBe(-1);
  });
});
