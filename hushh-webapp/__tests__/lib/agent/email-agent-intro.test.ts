import { beforeEach, describe, expect, it } from "vitest";

import {
  buildEmailAgentIntroPrompt,
  hasSeenEmailAgentIntro,
  markEmailAgentIntroSeen,
} from "@/lib/agent/email-agent-intro";

describe("buildEmailAgentIntroPrompt", () => {
  it("creates the first ordinary Agent Chat prompt for the connected owner", () => {
    expect(buildEmailAgentIntroPrompt(" me@example.com ")).toBe(
      "Can you send an email to 'me@example.com', In the email explain features of the email agent.",
    );
  });
});

describe("email agent intro gate", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reports unseen for a user who has never opened the agent", () => {
    expect(hasSeenEmailAgentIntro("user-1")).toBe(false);
  });

  it("reports seen only after the intro has been marked", () => {
    markEmailAgentIntroSeen("user-1");
    expect(hasSeenEmailAgentIntro("user-1")).toBe(true);
  });

  it("keeps the flag per user so a second account still gets introduced", () => {
    markEmailAgentIntroSeen("user-1");
    expect(hasSeenEmailAgentIntro("user-2")).toBe(false);
  });

  it("survives a reload, which is the whole point of persisting it", () => {
    markEmailAgentIntroSeen("user-1");
    // A fresh page would read the same backing store rather than fresh state.
    expect(
      window.localStorage.getItem("one_email_agent_intro_seen_v1:user-1"),
    ).toBe("1");
    expect(hasSeenEmailAgentIntro("user-1")).toBe(true);
  });

  it("treats a missing user id as unseen rather than writing a shared key", () => {
    markEmailAgentIntroSeen(null);
    expect(hasSeenEmailAgentIntro(null)).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it("ignores surrounding whitespace in the user id", () => {
    markEmailAgentIntroSeen(" user-1 ");
    expect(hasSeenEmailAgentIntro("user-1")).toBe(true);
  });
});
