import type { SourceBoundEmailReplyAdapter } from "@/components/agent/email-draft-card";
import { richEmailPlainText } from "@/components/agent/email-rich-text";
import type { GmailSendReadiness } from "@/lib/agent/email-draft-tool-result";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import { EmailDeliveryService, type EmailDraft } from "@/lib/services/email-delivery-service";
import { parseGmailReviewDirective } from "./email-agent-contract";

type EmailReviewPorts = {
  hasChatAccess: boolean;
  requireAccess: () => void;
  resetKyc: () => void;
  setInstruction: (value: string) => void;
  setDraft: (value: EmailDraft) => void;
  setAutoDraft: (value: boolean) => void;
  setGmailSend: (value: GmailSendReadiness | null) => void;
  setAnchor: (value: string) => void;
  setOpen: (value: boolean) => void;
};

/** Only the existing review card can turn these prepared fields into a Send. */
export function openPreparedEmailReview(directive: SpecialistDirectiveEvent, messageId: string, ports: EmailReviewPorts): boolean {
  if (directive.delegateAgentId !== "agent_email") return false;
  const review = parseGmailReviewDirective(directive.directive.payload);
  if (!review) return false;
  if (!ports.hasChatAccess) {
    ports.requireAccess();
    return true;
  }
  ports.resetKyc();
  ports.setInstruction(review.operation === "reply_to_thread" ? "Review your reply." : "Review your Mail draft.");
  ports.setDraft(review.draft);
  ports.setAutoDraft(false);
  ports.setGmailSend(null);
  ports.setAnchor(messageId);
  ports.setOpen(true);
  return true;
}

/** Reuse the reviewed send owner with exactly one original-message binding. */
export function createSourceBoundEmailReply(input: {
  workflowId: string | null; sourceMailRef?: string; envelope: EmailDraft | null;
}): SourceBoundEmailReplyAdapter | null {
  const { workflowId, sourceMailRef, envelope } = input;
  if (!workflowId && !sourceMailRef) return null;
  return {
    reportsSendStart: true,
    send: async ({ firebaseIdToken, vaultOwnerToken, draft, idempotencyKey, onSendRequestStarted, onPrepared }) => {
      const body = richEmailPlainText(draft.body);
      if (!body) throw new Error("Write a reply before sending it.");
      if (sourceMailRef && !envelope) throw new Error("Review the original reply again before sending it.");
      const sourceBoundDraft: EmailDraft = {
        ...draft,
        ...(sourceMailRef ? { to: envelope!.to, cc: "", bcc: "", subject: envelope!.subject,
          sourceMailRef, sourceWorkflowId: undefined } : { sourceWorkflowId: workflowId!, sourceMailRef: undefined }),
        body, htmlBody: draft.htmlBody ?? draft.body,
      };
      const prepared = await EmailDeliveryService.prepare({ firebaseIdToken, vaultOwnerToken,
        draft: sourceBoundDraft, idempotencyKey });
      if (!prepared.actionId) throw new Error("Mail could not be prepared for sending.");
      onPrepared?.(prepared.actionId);
      onSendRequestStarted?.();
      const sent = await EmailDeliveryService.send({ firebaseIdToken, vaultOwnerToken,
        actionId: prepared.actionId, senderToken: prepared.senderToken, draft: sourceBoundDraft });
      return { outcomeUnknown: sent.outcomeUnknown };
    },
  };
}
