// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildEmailAgentIntroPrompt,
  hasSeenEmailAgentIntro,
  markEmailAgentIntroSeen,
} from "@/lib/agent/email-agent-intro";

describe("buildEmailAgentIntroPrompt", () => {
  it("creates the first ordinary Agent Chat prompt for the connected owner", () => {
    const prompt = buildEmailAgentIntroPrompt(" me@example.com ");
    expect(prompt).toContain(
      "Can you send a mail to 'me@example.com', In the mail explain features of the mail agent.",
    );
    expect(prompt).toContain(
      "Strictly follow these email output formatting rules:",
    );
    expect(prompt).toContain('Greeting line: "Hi [Name],"');
    expect(prompt).toContain('Sign-off: always "Best,"');
  });
});

describe("email agent intro gate", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage: Storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
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
