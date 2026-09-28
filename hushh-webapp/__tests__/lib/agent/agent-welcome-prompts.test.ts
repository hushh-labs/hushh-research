import { describe, expect, it } from "vitest";

import {
  ALL_WELCOME_PROMPTS,
  getWelcomePromptSetIndex,
  getWelcomePrompts,
} from "@/lib/agent/agent-welcome-prompts";

describe("agent welcome prompts", () => {
  it("chooses a bounded curated set and never repeats the immediately prior set", () => {
    const first = getWelcomePromptSetIndex(null, 0.5);
    const next = getWelcomePromptSetIndex(first, 0.5);

    expect(getWelcomePrompts(first)).toHaveLength(3);
    expect(next).not.toBe(first);
  });

  it("offers only starters a One chat tool answers end to end", () => {
    expect(ALL_WELCOME_PROMPTS).toEqual([
      "What's on my calendar this week?",
      "Which emails need a reply?",
      "Who has access to my information?",
      "Find 30 free minutes tomorrow afternoon",
      "Draft a thank-you email",
      "What do you remember about me?",
    ]);
  });

  it("never advertises a capability with no working chat tool", () => {
    // Portfolio review invents numbers (finance lane has no tools), Drive reads
    // show the wrong never-connected copy, and One has no bank-spending tool.
    const text = ALL_WELCOME_PROMPTS.join("\n").toLowerCase();
    for (const unsupported of ["portfolio", "drive", "spend", "bank", "analyze", "share my"]) {
      expect(text).not.toContain(unsupported);
    }
  });
});
