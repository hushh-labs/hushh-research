import { describe, expect, it } from "vitest";

import { appendThinkingSummary, THINKING_SUMMARY_MAX_CHARS } from "@/lib/agent/thinking-summary";

describe("appendThinkingSummary", () => {
  it("starts a new bold heading on its own paragraph", () => {
    const first = appendThinkingSummary(undefined, "**Clarifying My Role**\n\nExplaining what I can do.");
    const joined = appendThinkingSummary(first, "**Refining My Answer**\n\nKeeping it short.");
    expect(joined).toBe(
      "**Clarifying My Role**\n\nExplaining what I can do.\n\n**Refining My Answer**\n\nKeeping it short.",
    );
  });

  it("keeps ordinary streaming pieces contiguous", () => {
    const first = appendThinkingSummary("", "**Checking the");
    expect(appendThinkingSummary(first, " connected file**")).toBe("**Checking the connected file**");
    expect(appendThinkingSummary("Reading the", " calendar.")).toBe("Reading the calendar.");
  });

  it("does not add a second blank line when one is already there", () => {
    expect(appendThinkingSummary("Done.\n\n", "**Next**")).toBe("Done.\n\n**Next**");
    expect(appendThinkingSummary("Done.\n", "**Next**")).toBe("Done.\n\n**Next**");
  });

  it("stays bounded", () => {
    const long = "x".repeat(THINKING_SUMMARY_MAX_CHARS);
    expect(appendThinkingSummary(long, "more")).toHaveLength(THINKING_SUMMARY_MAX_CHARS);
  });
});
