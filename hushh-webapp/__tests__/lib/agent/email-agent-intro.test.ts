import { describe, expect, it } from "vitest";

import {
  buildEmailAgentIntroPrompt,
  EMAIL_AGENT_INTRO_BODY,
  EMAIL_AGENT_INTRO_SUBJECT,
} from "@/lib/agent/email-agent-intro";

describe("buildEmailAgentIntroPrompt", () => {
  it("creates the standard review-first intro email for the connected owner", () => {
    const prompt = buildEmailAgentIntroPrompt(" me@example.com ");

    expect(prompt).toContain("To: me@example.com");
    expect(prompt).toContain(`Subject: ${EMAIL_AGENT_INTRO_SUBJECT}`);
    expect(prompt).toContain(EMAIL_AGENT_INTRO_BODY);
    expect(prompt).toContain("demonstrate the core features of the Gmail Agent");
    expect(prompt).toContain("Do not send it; I will review it first.");
  });
});
