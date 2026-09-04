import { describe, expect, it } from "vitest";

import { buildGmailAgentHandoffPrompt } from "@/lib/agent/email-agent-intro";

describe("buildGmailAgentHandoffPrompt", () => {
  it("prepares the guided Gmail feature email for the connected account", () => {
    expect(buildGmailAgentHandoffPrompt("me@example.com")).toBe(
      "Send an email to 'me@example.com' explaining all the features of the Gmail agent in detail. Prepare the draft for my review and do not send it without my explicit approval.",
    );
  });

  it("keeps the approval requirement when no connected address is available", () => {
    expect(buildGmailAgentHandoffPrompt("")).toContain(
      "review the draft before anything is sent",
    );
  });
});
