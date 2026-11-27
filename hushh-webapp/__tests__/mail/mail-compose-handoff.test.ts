/**
 * Compose and Reply hand off to One's existing reviewed draft card. The handoff
 * is metadata only, opens for the right owner only, and a reply is never quietly
 * downgraded into a plain compose.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateToAgentChat = vi.fn();
vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: () => navigateToAgentChat(),
}));

import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { hasUnsentMailText, mailHandoffCard } from "@/lib/chat/email-draft-review";
import { openMailComposeInChat, openMailReplyInChat } from "@/lib/mail/mail-compose-handoff";

const context = {
  ownerId: "owner-1",
  accountKey: "acct-1",
  accountEmail: "me@example.com",
  expectedAccount: "google-sub-1",
};
const reference = `rs1.${"x".repeat(40)}`;
const sourceId = `ms1.${"S".repeat(43)}`;
const reply = {
  sourceMailRef: reference,
  to: "alice@example.com",
  recipientLabel: "Alice",
  subject: "Re: Invoice",
  expiresInSeconds: 900,
};

beforeEach(() => {
  useOneConversationSession.getState().clearSession();
  navigateToAgentChat.mockReset();
});

describe("Mail compose handoff", () => {
  it("Compose carries the intent and the mailbox, then enters One's chat", () => {
    openMailComposeInChat(context);

    const handoff = useOneConversationSession.getState().pendingHandoff;
    expect(handoff).toMatchObject({
      reason: "user_requested",
      mailCompose: { ...context, intent: "compose" },
    });
    expect(handoff?.mailCompose?.reply).toBeUndefined();
    expect(navigateToAgentChat).toHaveBeenCalledOnce();
  });

  it("Reply carries the server-derived envelope, its reference and the stable source, never mail text or a Gmail id", () => {
    vi.useFakeTimers({ now: 5_000 });
    openMailReplyInChat({ ...context, reply, sourceId });
    vi.useRealTimers();

    const compose = useOneConversationSession.getState().pendingHandoff?.mailCompose;
    expect(compose).toEqual({
      ...context,
      intent: "reply",
      reply: {
        to: "alice@example.com",
        subject: "Re: Invoice",
        sourceMailRef: reference,
        recipientLabel: "Alice",
        // What lets the reference be renewed on the same original email.
        sourceId,
        expiresInSeconds: 900,
        issuedAtMs: 5_000,
        // No starting text unless one is given.
        body: null,
      },
    });
    expect(JSON.stringify(compose)).not.toMatch(/message_id|thread/i);
    expect(navigateToAgentChat).toHaveBeenCalledOnce();
  });

  it("a verified starting text rides along as the draft's first words, and blank text is nothing", () => {
    openMailReplyInChat({ ...context, reply, sourceId, body: "Could you send the signed copy when you can?" });
    expect(useOneConversationSession.getState().pendingHandoff?.mailCompose?.reply?.body).toBe(
      "Could you send the signed copy when you can?",
    );

    openMailReplyInChat({ ...context, reply, sourceId, body: "  \n " });
    expect(useOneConversationSession.getState().pendingHandoff?.mailCompose?.reply?.body).toBeNull();
  });
});

describe("mailHandoffCard: what the reviewed card opens with", () => {
  const replyHandoff = {
    ...context,
    intent: "reply" as const,
    reply: {
      to: reply.to,
      subject: reply.subject,
      sourceMailRef: reply.sourceMailRef,
      recipientLabel: reply.recipientLabel,
      sourceId,
      expiresInSeconds: 900,
      issuedAtMs: 7_000,
    },
  };

  it("opens the card with a given starting text, editable and still unsent", () => {
    const card = mailHandoffCard(
      { ...replyHandoff, reply: { ...replyHandoff.reply, body: "Thank you, Priya." } },
      "owner-1",
    );
    expect(card?.draft).toMatchObject({ to: reply.to, body: "Thank you, Priya.", sourceMailRef: reply.sourceMailRef });
    // The binding is unchanged: the same original, renewable, with nothing about delivery.
    expect(card?.binding?.sourceId).toBe(sourceId);
  });

  it("opens a reply source-bound, with an empty body for the person to write", () => {
    expect(mailHandoffCard(replyHandoff, "owner-1")).toEqual({
      // The binding is what lets the reference be renewed from the same email.
      binding: {
        ownerId: "owner-1",
        sourceId,
        expectedAccount: "google-sub-1",
        reply: {
          sourceMailRef: reference,
          to: "alice@example.com",
          subject: "Re: Invoice",
          expiresInSeconds: 900,
        },
        issuedAtMs: 7_000,
      },
      instruction: "Review your reply.",
      draft: {
        to: "alice@example.com",
        cc: "",
        bcc: "",
        subject: "Re: Invoice",
        body: "",
        sourceMailRef: reference,
      },
    });
  });

  it("opens a compose empty, with no recipient or source", () => {
    expect(mailHandoffCard({ ...context, intent: "compose" }, "owner-1")).toEqual({
      instruction: "Write a new email.",
      draft: null,
      binding: null,
    });
  });

  it("never opens for a different owner or before the owner is known", () => {
    expect(mailHandoffCard(replyHandoff, "owner-2")).toBeNull();
    expect(mailHandoffCard(replyHandoff, null)).toBeNull();
    expect(mailHandoffCard({ ...context, intent: "compose" }, "owner-2")).toBeNull();
    // Negative control: the right owner opens it.
    expect(mailHandoffCard(replyHandoff, "owner-1")).not.toBeNull();
  });

  it("drops a reply with a missing or malformed source instead of opening a compose", () => {
    const broken = [
      { ...context, intent: "reply" as const },
      { ...replyHandoff, reply: { ...replyHandoff.reply, sourceMailRef: "ms1.not-a-reply-reference" } },
      { ...replyHandoff, reply: { ...replyHandoff.reply, sourceMailRef: "" } },
      { ...replyHandoff, reply: { ...replyHandoff.reply, to: "  " } },
      // A reply that cannot be renewed from its original is not opened half-bound.
      { ...replyHandoff, reply: { ...replyHandoff.reply, sourceId: reference } },
      { ...replyHandoff, reply: { ...replyHandoff.reply, sourceId: "" } },
    ];
    for (const handoff of broken) expect(mailHandoffCard(handoff, "owner-1")).toBeNull();
  });
});

describe("hasUnsentMailText: when leaving would lose the person's words", () => {
  it("is true only for a body with something written in it", () => {
    expect(hasUnsentMailText({ body: "Thanks, I'll pay on Friday." })).toBe(true);
    expect(hasUnsentMailText({ body: "<p>Hello</p>" })).toBe(true);
    expect(hasUnsentMailText({ body: "" })).toBe(false);
    expect(hasUnsentMailText({ body: "  \n\t " })).toBe(false);
    expect(hasUnsentMailText({ body: "<p><br></p>" })).toBe(false);
    expect(hasUnsentMailText(null)).toBe(false);
    expect(hasUnsentMailText(undefined)).toBe(false);
  });

  it("does not count the text the card opened with until the person changes it", () => {
    expect(hasUnsentMailText({ body: "Write a new email." }, "Write a new email.")).toBe(false);
    expect(hasUnsentMailText({ body: "<p>Write a new email.</p>" }, "Write a new email.")).toBe(false);
    expect(hasUnsentMailText({ body: "Could you send it?" }, "Could you send it?")).toBe(false);
    expect(hasUnsentMailText({ body: "Write a new email. Thanks." }, "Write a new email.")).toBe(true);
    expect(hasUnsentMailText({ body: "Thanks, I'll pay on Friday." }, "Write a new email.")).toBe(true);
    expect(hasUnsentMailText({ body: "Anything" }, null)).toBe(true);
  });
});
