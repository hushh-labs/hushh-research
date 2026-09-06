import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/gmail/gmail-receipts-page.tsx"),
  "utf8",
);

describe("Gmail Email Agent handoff contract", () => {
  it("opens One Chat without queuing anything for it to draft", () => {
    // The workspace used to hand One a demonstration prompt -- "explain all
    // the features of the Gmail agent" -- so every press started a sample
    // email about the agent itself. Opening chat now leaves the composer
    // empty for whatever the owner actually came to write.
    expect(source).toContain("const handleOpenOneChat = useCallback(() => {");
    expect(source).toContain("agentPopover.openAgent();");
    expect(source).toContain("router.push(ROUTES.AGENT);");
    expect(source).not.toContain("createHandoff");
    expect(source).not.toContain("buildGmailAgentHandoffPrompt");
  });

  it("no longer promises a sample email before opening chat", () => {
    expect(source).not.toContain("Start with a guided Gmail email");
    expect(source).not.toContain("explaining what the Gmail agent can do");
  });
});
