import type { SourceBoundEmailReplyAdapter } from "@/components/agent/email-draft-card";
import { richEmailPlainText } from "@/components/agent/email-rich-text";
import type { GmailSendReadiness } from "@/lib/agent/email-draft-tool-result";
import type { MailComposeHandoff } from "@/lib/agent/one-conversation-session";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import { MailOverviewError } from "@/lib/mail/mail-overview-client";
import { mailReplyFailureCopy } from "@/lib/mail/mail-overview-copy";
import { isMailSourceId, type MailReplyBindingInput, type MailReplyRenewal } from "@/lib/mail/mail-reply-binding";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type EmailDraft,
} from "@/lib/services/email-delivery-service";
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

/**
 * A reply whose short-lived reference ran out before the person sent it. Mail
 * renews the reference from the same original email; a send never continues on
 * the renewal, so the person reviews what they wrote and sends it themselves.
 */
export type ReplyRenewal = {
  renew: (vaultOwnerToken: string) => Promise<MailReplyRenewal | null>;
};

const EXPIRED_REPLY_CODES = new Set(["REPLY_SOURCE_REF_EXPIRED", "REPLY_SOURCE_REF_INVALID"]);

const RENEWAL_FAILURE_CODES: Partial<Record<MailOverviewError["reason"], string>> = {
  source_unavailable: "REPLY_SOURCE_UNAVAILABLE",
  source_invalid: "REPLY_SOURCE_UNAVAILABLE",
  account_changed: "REPLY_ACCOUNT_CHANGED",
  connect_required: "GMAIL_READ_PERMISSION_REQUIRED",
  reconnect_required: "GMAIL_READ_PERMISSION_REQUIRED",
  reply_unavailable: "MAIL_REPLY_UNAVAILABLE",
  reply_not_possible: "REPLY_TARGET_AMBIGUOUS",
};

/** What a reply that expired becomes. Every code here means nothing was sent. */
async function expiredReplyFailure(
  cause: unknown,
  renewal: ReplyRenewal | undefined,
  vaultOwnerToken: string,
): Promise<unknown> {
  if (!renewal || !(cause instanceof EmailDeliveryError) || !EXPIRED_REPLY_CODES.has(cause.code ?? "")) {
    return cause;
  }
  try {
    const renewed = await renewal.renew(vaultOwnerToken);
    if (!renewed) return cause;
    return new EmailDeliveryError(
      renewed.changed
        ? "The original email now has different reply details. Nothing was sent. Review the reply, then send it."
        : "Your reply was refreshed from the original email. Nothing was sent. Review it, then send it.",
      409,
      "REPLY_SOURCE_REFRESHED",
    );
  } catch (renewalError) {
    if (renewalError instanceof MailOverviewError) {
      const copy = mailReplyFailureCopy(renewalError);
      return new EmailDeliveryError(
        copy.action === "retry"
          ? "Mail couldn't check the original email just now. Nothing was sent. Try again."
          : `${copy.message} Nothing was sent.`,
        409,
        RENEWAL_FAILURE_CODES[renewalError.reason] ?? "REPLY_SOURCE_RETRYABLE",
      );
    }
    return new EmailDeliveryError(
      "Mail couldn't check the original email just now. Nothing was sent. Try again.",
      503,
      "REPLY_SOURCE_RETRYABLE",
    );
  }
}

/** Reuse the reviewed send owner with exactly one original-message binding. */
export function createSourceBoundEmailReply(input: {
  workflowId: string | null; sourceMailRef?: string; envelope: EmailDraft | null;
  renewal?: ReplyRenewal;
}): SourceBoundEmailReplyAdapter | null {
  const { workflowId, sourceMailRef, envelope, renewal } = input;
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
      try {
        const prepared = await EmailDeliveryService.prepare({ firebaseIdToken, vaultOwnerToken,
          draft: sourceBoundDraft, idempotencyKey });
        if (!prepared.actionId) throw new Error("Mail could not be prepared for sending.");
        onPrepared?.(prepared.actionId);
        onSendRequestStarted?.();
        const sent = await EmailDeliveryService.send({ firebaseIdToken, vaultOwnerToken,
          actionId: prepared.actionId, senderToken: prepared.senderToken, draft: sourceBoundDraft });
        return { outcomeUnknown: sent.outcomeUnknown };
      } catch (cause) {
        throw await expiredReplyFailure(cause, renewal, vaultOwnerToken);
      }
    },
  };
}

/**
 * What the reviewed card opens with for a Compose or Reply that Mail's Overview
 * handed over, or null when it must not open at all. Metadata in, card state
 * out: nothing here sends, and a reply's recipient and thread stay derived by
 * the server from its source reference.
 *
 * It opens only for the owner it was made for, and a reply is never quietly
 * downgraded into a plain compose: a reply whose source is missing or malformed
 * is dropped, because a new message to a wrong or empty recipient is not what
 * the person asked for.
 */
export function mailHandoffCard(
  compose: MailComposeHandoff,
  ownerId: string | null,
): { instruction: string; draft: EmailDraft | null; binding: MailReplyBindingInput | null } | null {
  if (!ownerId || compose.ownerId !== ownerId) return null;
  if (compose.intent === "compose") {
    return { instruction: "Write a new email.", draft: null, binding: null };
  }
  const reply = compose.reply;
  if (
    !reply ||
    !reply.to.trim() ||
    !/^rs1\.[A-Za-z0-9_-]{16,2044}$/.test(reply.sourceMailRef) ||
    !isMailSourceId(reply.sourceId)
  ) {
    return null;
  }
  return {
    binding: {
      ownerId,
      sourceId: reply.sourceId,
      expectedAccount: compose.expectedAccount,
      reply: {
        sourceMailRef: reply.sourceMailRef,
        to: reply.to,
        subject: reply.subject,
        expiresInSeconds: reply.expiresInSeconds,
      },
      issuedAtMs: reply.issuedAtMs,
    },
    instruction: "Review your reply.",
    draft: {
      to: reply.to,
      cc: "",
      bcc: "",
      subject: reply.subject,
      body: typeof reply.body === "string" ? reply.body : "",
      sourceMailRef: reply.sourceMailRef,
    },
  };
}

/**
 * True when leaving the draft card would throw away words the person wrote.
 * Nothing about a reply's recipient or subject counts: those come back from the
 * original email, so only the body is the person's to lose.
 */
export function hasUnsentMailText(draft: Pick<EmailDraft, "body"> | null | undefined): boolean {
  return Boolean(draft?.body && richEmailPlainText(draft.body).trim());
}
