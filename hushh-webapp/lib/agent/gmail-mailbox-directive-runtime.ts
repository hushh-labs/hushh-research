import { EmailDeliveryService } from "@/lib/services/email-delivery-service";
import type { DelegateResult, SpecialistDirective } from "@/lib/agent/specialist-directive-runtime";

export type GmailMailboxAction =
  | "archive"
  | "add_label"
  | "remove_label"
  | "mark_read"
  | "mark_unread"
  | "trash";

function emails(count: number): string {
  return count === 1 ? "1 email" : `${count} emails`;
}

/** Per-action copy for the pending and completed chat messages. */
export const GMAIL_MAILBOX_ACTION_COPY: Record<
  GmailMailboxAction,
  { pending: string; done: (count: number, label: string) => string }
> = {
  archive: { pending: "Archiving…", done: (n) => `Archived ${emails(n)}.` },
  add_label: {
    pending: "Adding label…",
    done: (n, label) => `Added the label “${label}” to ${emails(n)}.`,
  },
  remove_label: {
    pending: "Removing label…",
    done: (n, label) => `Removed the label “${label}” from ${emails(n)}.`,
  },
  mark_read: { pending: "Marking as read…", done: (n) => `Marked ${emails(n)} as read.` },
  mark_unread: { pending: "Marking as unread…", done: (n) => `Marked ${emails(n)} as unread.` },
  trash: { pending: "Moving to Trash…", done: (n) => `Moved ${emails(n)} to Trash.` },
};

export function gmailMailboxAction(payload: Record<string, unknown>): GmailMailboxAction | null {
  const action = String(payload.action ?? "");
  return action in GMAIL_MAILBOX_ACTION_COPY ? (action as GmailMailboxAction) : null;
}

/** One review line per exact message the change touches. */
export function gmailMailboxDetails(payload: Record<string, unknown>): string[] {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.slice(0, 25).map((raw) => {
    const message = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const subject = String(message.subject || "(no subject)");
    const sender = String(message.sender || "Unknown sender");
    return `${sender} · ${subject}`;
  });
}

/** Execute the exact, server-persisted mailbox change shown in the chat card. */
export async function runGmailMailboxDirective(
  directive: SpecialistDirective,
  auth: { firebaseIdToken: string; vaultOwnerToken: string },
): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, unknown>;
  const proposalId = String(payload.proposalId ?? "");
  const action = gmailMailboxAction(payload);
  if (payload.type !== "gmail.execute_mailbox_proposal" || !proposalId || !action) {
    throw new Error("Mailbox confirmation is invalid.");
  }
  const result = await EmailDeliveryService.executeMailboxProposal({ ...auth, proposalId });
  return {
    delegate_agent_id: "agent_email",
    kind: "action",
    id: proposalId,
    type: `gmail.${action}`,
    status: "completed",
    detail: GMAIL_MAILBOX_ACTION_COPY[action].done(result.count, String(payload.label ?? "")),
  };
}
