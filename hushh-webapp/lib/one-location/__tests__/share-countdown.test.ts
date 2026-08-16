import { describe, expect, it } from "vitest";

import {
  describeShareElapsed,
  describeShareRemaining,
  formatShareDuration,
  parseTimestamp,
  shareProgressRatio,
} from "@/lib/one-location/share-countdown";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatShareDuration", () => {
  it("counts seconds inside the last hour, so the number visibly moves", () => {
    expect(formatShareDuration(59 * MINUTE + 5 * SECOND)).toBe("59:05");
    expect(formatShareDuration(47 * MINUTE)).toBe("47:00");
    expect(formatShareDuration(9 * SECOND)).toBe("00:09");
  });

  it("holds a fixed width so the layout never jitters as digits change", () => {
    const widths = new Set(
      [9, 59, 599, 3599].map((s) => formatShareDuration(s * SECOND).length),
    );
    expect(widths).toEqual(new Set([5]));
  });

  it("settles to minutes above an hour, where seconds are noise", () => {
    expect(formatShareDuration(HOUR)).toBe("1h 00m");
    expect(formatShareDuration(HOUR + 47 * MINUTE + 30 * SECOND)).toBe("1h 47m");
    expect(formatShareDuration(23 * HOUR + 59 * MINUTE)).toBe("23h 59m");
  });

  it("settles to days beyond a day", () => {
    expect(formatShareDuration(DAY)).toBe("1d 0h");
    expect(formatShareDuration(2 * DAY + 3 * HOUR)).toBe("2d 3h");
  });

  it("floors at zero rather than showing a negative clock", () => {
    expect(formatShareDuration(0)).toBe("00:00");
    expect(formatShareDuration(-5000)).toBe("00:00");
  });
});

describe("describeShareRemaining", () => {
  it("gives assistive tech a sentence, not a per-second number", () => {
    expect(describeShareRemaining(47 * MINUTE)).toBe("47 minutes left");
    expect(describeShareRemaining(MINUTE)).toBe("1 minute left");
    expect(describeShareRemaining(30 * SECOND)).toBe("Less than a minute left");
    expect(describeShareRemaining(HOUR)).toBe("1 hour left");
    expect(describeShareRemaining(2 * HOUR + 5 * MINUTE)).toBe(
      "2 hours 5 minutes left",
    );
    expect(describeShareRemaining(0)).toBe("Sharing is stopping now");
  });
});

describe("describeShareElapsed", () => {
  it("reports time served for a share that runs until you stop it", () => {
    expect(describeShareElapsed(30 * SECOND)).toBe(
      "Sharing for less than a minute",
    );
    expect(describeShareElapsed(MINUTE)).toBe("Sharing for 1 minute");
    expect(describeShareElapsed(12 * MINUTE)).toBe("Sharing for 12 minutes");
    expect(describeShareElapsed(3 * HOUR)).toBe("Sharing for 3 hours");
  });
});

describe("shareProgressRatio", () => {
  const start = Date.parse("2026-08-16T09:00:00.000Z");
  const end = Date.parse("2026-08-16T10:00:00.000Z");

  it("fills in step with the time actually spent", () => {
    expect(shareProgressRatio(start, end, start)).toBe(0);
    expect(shareProgressRatio(start, end, start + 30 * MINUTE)).toBe(0.5);
    expect(shareProgressRatio(start, end, end)).toBe(1);
  });

  it("clamps rather than overflowing when the clock drifts past the window", () => {
    expect(shareProgressRatio(start, end, start - HOUR)).toBe(0);
    expect(shareProgressRatio(start, end, end + HOUR)).toBe(1);
  });

  it("has no bar to draw for an open-ended or zero-length share", () => {
    expect(shareProgressRatio(start, null, start)).toBeNull();
    expect(shareProgressRatio(null, end, start)).toBeNull();
    expect(shareProgressRatio(start, start, start)).toBeNull();
  });
});

describe("parseTimestamp", () => {
  it("rejects anything that is not a real instant", () => {
    expect(parseTimestamp("2026-08-16T09:00:00.000Z")).toBe(
      Date.parse("2026-08-16T09:00:00.000Z"),
    );
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not a date")).toBeNull();
  });
});
