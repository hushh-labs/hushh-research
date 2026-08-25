import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/gmail/gmail-receipts-page.tsx"),
  "utf8",
);

describe("Gmail Email Agent handoff contract", () => {
  it("queues the intro as a normal Agent Chat transcript", () => {
    expect(source).toContain("transcript: buildEmailAgentIntroPrompt(emailAgentIntroRecipient)");
    expect(source).toContain("createHandoff({");
    expect(source).toContain("agentPopover.openAgent();");
    expect(source).not.toContain(
      "emailDraftInstruction: buildEmailAgentIntroPrompt(emailAgentIntroRecipient)",
    );
  });
});
