import { describe, expect, it } from "vitest";

import {
  getWelcomePromptSetIndex,
  getWelcomePrompts,
} from "@/lib/agent/agent-welcome-prompts";

describe("agent welcome prompts", () => {
  it("chooses a bounded curated set and never repeats the immediately prior set", () => {
    const first = getWelcomePromptSetIndex(null, 0.5);
    const next = getWelcomePromptSetIndex(first, 0.5);

    expect(getWelcomePrompts(first, { hasPortfolioData: true })).toHaveLength(3);
    expect(next).not.toBe(first);
  });

  it("does not offer a portfolio review before a portfolio is configured", () => {
    const prompts = getWelcomePrompts(0, { hasPortfolioData: false });

    expect(prompts).toContain("Set up my portfolio");
    expect(prompts).not.toContain("Review my portfolio");
  });

  it("keeps the configured portfolio review available when holdings exist", () => {
    expect(getWelcomePrompts(0, { hasPortfolioData: true })).toContain(
      "Review my portfolio",
    );
  });
});
