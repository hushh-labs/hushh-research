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
    expect(source).toContain('event.raw.toolName !== "open_gmail_email_draft"');
    expect(source).toContain("setEmailDraftAutoDraft(!payload.initialDraft);");
    expect(source).toContain("initialDraft: body");
    expect(source).toContain("getGmailInformationRequestReplyPayload");
    expect(source).toContain('event.raw.toolName !== "open_gmail_information_request_reply"');
    expect(source).toContain(
      '"Reply to the selected Gmail email with appropriate details from my PKM."',
    );
    expect(source).toContain("gmailInformationRequestWorkflowId: gmailInformationRequest.workflow_id");
    expect(source).not.toContain("prepareScopedGmailInformationRequestDraft");
    expect(source).toContain("autoDraft={emailDraftAutoDraft}");
    expect(source).toContain("onSendStarted={handleEmailSendStarted}");
    expect(source).toContain("EmailDeliveryHistoryCard");
    expect(source).toContain("bucketEmailDeliveryTimelineItems");
    expect(source).toContain("emailDraftAnchorMessageId");
    expect(source).toContain("setEmailDraftAnchorMessageId(assistantMessageId);");
    expect(source).toContain("message.id === emailDraftAnchorMessageId");
    expect(source).toContain("renderEmailDraftCard()");
    expect(source).toContain("sourceBoundReply=");
    expect(source).toContain("sourceBoundEnvelope={gmailKycEmailDraftEnvelope}");
    expect(source).toContain("source.reply_to?.trim() || source.from.trim()");
    expect(source).not.toContain("sourceBoundContext=");
    expect(source).not.toContain("gmailKycRequestSummary");
    expect(source).toContain("sourceWorkflowId: workflowId");
    expect(source).toContain("const prepared = await EmailDeliveryService.prepare");
    expect(source).not.toContain("GmailInformationRequestsService.prepareReply");
    expect(source).not.toContain("GmailKycReplyCard");
    expect(source).toContain("itemsAfterMessage.get(message.id)");
    expect(source).toContain(
      "openGmailEmailDraftFromDirective(toolEvent, assistantMessageId);",
    );
    expect(source).toContain("kycInformationSaveConfirmed:");
    expect(source).toContain("gmailInformationRequestWorkflowId:");
    expect(source).not.toContain(
      "current.filter((message) => message.id !== assistantMessageId)",
    );
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
