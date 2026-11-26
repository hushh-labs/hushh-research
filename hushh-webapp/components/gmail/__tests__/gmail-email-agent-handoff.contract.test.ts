import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const source = read("components/gmail/gmail-receipts-page.tsx");
const handoff = read("lib/mail/mail-compose-handoff.ts");
const workspace = read("components/agent/agent-chat-workspace.tsx");

describe("Gmail Email Agent handoff contract", () => {
  it("hands One an explicit Mail intent and queues nothing for it to draft", () => {
    // The workspace used to hand One a demonstration prompt -- "explain all
    // the features of the Gmail agent" -- so every press started a sample
    // email about the agent itself. Mail's Overview now carries an explicit
    // compose or reply intent into the reviewed draft card instead: metadata
    // only, never a prompt, a transcript or message text.
    expect(source).toContain("openMailComposeInChat");
    expect(source).toContain("openMailReplyInChat");
    expect(source).not.toContain("handleOpenOneChat");
    expect(handoff).toContain("mailCompose");
    expect(handoff).not.toContain("transcript");
    expect(handoff).not.toContain("emailDraftInstruction");
    expect(source).not.toContain("agentPopover");
    expect(source).not.toContain("agentRouteWithOrigin");
    expect(source).not.toContain("buildGmailAgentHandoffPrompt");
  });

  it("keeps a Mail reply on its original email for as long as it takes to write", () => {
    // The reply reference expires in 15 minutes. The workspace binds the
    // handoff's stable source id, renews while the reply is open, and resolves
    // any older reference to the newest one, so the text typed is never lost.
    expect(handoff).toContain("sourceId");
    expect(workspace).toContain("mailReplyBindings.register(card.binding)");
    expect(workspace).toContain("useMailReplyRenewal({");
    expect(workspace).toContain("mailReplyBindings.resolve(heldRef)");
    expect(workspace).toContain("renewal: replyRenewal");
    // The renewal is handed to the adapter; the card's own draft is never replaced.
    expect(workspace).toContain("initialDraft={emailDraftInitialValue}");
    expect(workspace).not.toContain("initialDraft={replyEnvelope}");
  });

  it("asks before Back to Mail discards words the person has written", () => {
    expect(workspace).toContain("hasUnsentMailText(\n              emailDraftCardValueRef.current,");
    expect(workspace).toContain("Leave this reply?");
    expect(workspace).toContain("Keep writing");
    // Leaving without text is one tap; with text, only the explicit Leave goes.
    expect(workspace).toContain("<AlertDialogAction onClick={() => router.push(ROUTES.GMAIL)}>Leave</AlertDialogAction>");
  });

  it("no longer promises a sample email before opening chat", () => {
    expect(source).not.toContain("Start with a guided Gmail email");
    expect(source).not.toContain("explaining what the Gmail agent can do");
  });
});
