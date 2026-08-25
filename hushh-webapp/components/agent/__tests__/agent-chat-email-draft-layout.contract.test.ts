import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);

describe("Agent Chat email draft layout contract", () => {
  it("keeps a draft in the conversation scroller, then hands send work to a collapsible history item", () => {
    expect(source).toContain("emailDraftOpen");
    expect(source).toContain("initialInstruction={emailDraftInstruction}");
    expect(source).toContain(
      "emailDraftInstruction = handoff.emailDraftInstruction?.trim()",
    );
    expect(source).toContain("openGmailEmailDraftFromDirective");
    expect(source).toContain('payload.kind !== "gmail_email_draft"');
    expect(source).toContain("setEmailDraftAutoDraft(true);");
    expect(source).toContain("autoDraft={emailDraftAutoDraft}");
    expect(source).toContain("onSendStarted={handleEmailSendStarted}");
    expect(source).toContain("EmailDeliveryHistoryCard");
    expect(source).toContain("setQueuedHandoffPrompt(emailDraftInstruction);");
    expect(source).not.toContain('aria-label="Draft an email"');
    expect(source).not.toContain(
      'className="shrink-0 border-t border-border/70 bg-background px-3 pt-3 sm:px-5"',
    );
  });

  it("reserves the expanded editor's full action rail on phones", () => {
    expect(source).toContain("pb-14 pr-32 pt-4");
  });
});
