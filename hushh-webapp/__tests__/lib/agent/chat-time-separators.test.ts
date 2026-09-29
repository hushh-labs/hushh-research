import { describe, expect, it } from "vitest";

import {
  CHAT_TIME_GROUP_GAP_MS,
  computeChatTimeSeparators,
  formatChatTimeSeparator,
} from "@/lib/agent/chat-time-separators";

// Local-time construction keeps day boundaries in the runner's own timezone.
const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 9, 29, 22, 0);

describe("computeChatTimeSeparators", () => {
  it("opens a group on the first message and after a meaningful gap, not per message", () => {
    const separators = computeChatTimeSeparators(
      [
        { id: "welcome", atMs: at(2026, 9, 29, 19, 18) },
        { id: "name-prompt", atMs: at(2026, 9, 29, 19, 18) },
        { id: "call-me", atMs: at(2026, 9, 29, 21, 23) },
        { id: "reply", atMs: at(2026, 9, 29, 21, 23) },
        { id: "calendar", atMs: at(2026, 9, 29, 21, 30) },
      ],
      NOW,
      "en-US",
    );
    expect([...separators.keys()]).toEqual(["welcome", "call-me"]);
    expect(separators.get("welcome")?.text).toBe("Today, 7:18 PM");
    expect(separators.get("call-me")?.dateTime).toBe(new Date(at(2026, 9, 29, 21, 23)).toISOString());
  });

  it("starts a new group when the calendar day changes even inside the gap", () => {
    const separators = computeChatTimeSeparators(
      [
        { id: "late", atMs: at(2026, 9, 28, 23, 55) },
        { id: "after-midnight", atMs: at(2026, 9, 29, 0, 5) },
      ],
      NOW,
      "en-US",
    );
    expect(separators.get("late")?.text).toBe("Yesterday, 11:55 PM");
    expect(separators.get("after-midnight")?.text).toBe("Today, 12:05 AM");
  });

  it("never invents a time for an untimed message", () => {
    const separators = computeChatTimeSeparators(
      [
        { id: "timed", atMs: at(2026, 9, 29, 9, 0) },
        { id: "untimed", atMs: null },
        { id: "later", atMs: at(2026, 9, 29, 9, 0) + CHAT_TIME_GROUP_GAP_MS },
      ],
      NOW,
      "en-US",
    );
    expect(separators.has("untimed")).toBe(false);
    expect(separators.has("later")).toBe(true);
    // A leading untimed item may only show the label it was already given.
    expect(computeChatTimeSeparators([{ id: "a", atMs: null }], NOW).size).toBe(0);
    expect(
      computeChatTimeSeparators([{ id: "a", atMs: null, label: "7:18 PM" }], NOW).get("a")?.text,
    ).toBe("7:18 PM");
  });
});

describe("formatChatTimeSeparator", () => {
  it("names older days by date and includes the year only when it differs", () => {
    expect(formatChatTimeSeparator(at(2026, 9, 25, 19, 50), NOW, "en-GB").text).toBe("25 Sept, 19:50");
    expect(formatChatTimeSeparator(at(2025, 12, 31, 8, 5), NOW, "en-US").text).toBe("Dec 31, 2025, 8:05 AM");
    expect(formatChatTimeSeparator(at(2026, 9, 25, 19, 50), NOW, "en-US").accessibleLabel).toMatch(
      /^Messages from Friday, September 25, 2026/,
    );
  });
});
