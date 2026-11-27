import type { MailReplySource } from "@/lib/mail/mail-overview-client";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";

type Context = {
  ownerId: string;
  /** The Google account the Overview is showing. */
  accountKey: string;
  accountEmail: string | null;
  /** The connected Google account's id. */
  expectedAccount: string | null;
};

/**
 * Compose and Reply enter One's existing reviewed draft card, with the intent
 * and the mailbox the person was looking at. Neither sends anything: the card
 * keeps the reviewed recipient, the editable body and the explicit Send.
 */
export function openMailComposeInChat(context: Context): void {
  useOneConversationSession.getState().createHandoff({
    reason: "user_requested",
    mailCompose: { ...context, intent: "compose" },
  });
  navigateToAgentChat();
}

export function openMailReplyInChat(
  context: Context & { reply: MailReplySource; sourceId: string; body?: string | null },
): void {
  const { reply, sourceId, body, ...rest } = context;
  useOneConversationSession.getState().createHandoff({
    reason: "user_requested",
    mailCompose: {
      ...rest,
      intent: "reply",
      reply: {
        to: reply.to,
        subject: reply.subject,
        sourceMailRef: reply.sourceMailRef,
        recipientLabel: reply.recipientLabel,
        sourceId,
        expiresInSeconds: reply.expiresInSeconds,
        issuedAtMs: Date.now(),
        body: typeof body === "string" && body.trim() ? body : null,
      },
    },
  });
  navigateToAgentChat();
}
