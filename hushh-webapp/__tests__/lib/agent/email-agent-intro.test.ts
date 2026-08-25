import { describe, expect, it } from "vitest";

import {
  buildEmailAgentIntroPrompt,
} from "@/lib/agent/email-agent-intro";

describe("buildEmailAgentIntroPrompt", () => {
  it("creates the first ordinary Agent Chat prompt for the connected owner", () => {
    expect(buildEmailAgentIntroPrompt(" me@example.com ")).toBe(
      "Can you send an email to 'me@example.com', In the email explain features of the email agent.",
    );
  });
});
