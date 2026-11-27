/**
 * A reply whose short-lived reference ran out before Send.
 *
 * The recovery has to do three things at once: keep the reply on the exact
 * original email, keep every word the person wrote, and never send on its own.
 * The server refuses an expired reference before it touches anything, so the
 * adapter renews it from the stable source and stops there; the person
 * reviews and sends it themselves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepare, send } = vi.hoisted(() => ({ prepare: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/services/email-delivery-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/email-delivery-service")>();
  return {
    ...actual,
    EmailDeliveryService: { ...actual.EmailDeliveryService, prepare, send },
  };
});

import { deliveryFailure } from "@/components/agent/email-draft-delivery";
import { createSourceBoundEmailReply } from "@/lib/chat/email-draft-review";
import { MailOverviewError } from "@/lib/mail/mail-overview-client";
import type { MailReplyRenewal } from "@/lib/mail/mail-reply-binding";
import { EmailDeliveryError, type EmailDraft } from "@/lib/services/email-delivery-service";

const REF_OLD = `rs1.${"o".repeat(40)}`;
const REF_NEW = `rs1.${"n".repeat(40)}`;
const envelope: EmailDraft = {
  to: "alice@example.com",
  cc: "",
  bcc: "",
  subject: "Re: Invoice",
  body: "",
  sourceMailRef: REF_OLD,
};
const WRITTEN = "Thanks Alice,\n\nI'll pay this on Friday.\n\nBest,\nMe";
const typed: EmailDraft = { ...envelope, body: WRITTEN, htmlBody: `<p>${WRITTEN}</p>` };

const attempt = (adapter: NonNullable<ReturnType<typeof createSourceBoundEmailReply>>) =>
  adapter.send({
    firebaseIdToken: "fb",
    vaultOwnerToken: "vault",
    draft: typed,
    idempotencyKey: "key-1",
  });

const expired = (code = "REPLY_SOURCE_REF_EXPIRED") =>
  new EmailDeliveryError("This reply expired. Ask One to prepare it again.", 410, code);

beforeEach(() => {
  prepare.mockReset();
  send.mockReset();
});

describe("an expired reply reference", () => {
  it("renews from the same original, sends nothing, and says so plainly", async () => {
    const renew = vi.fn<(token: string) => Promise<MailReplyRenewal | null>>().mockResolvedValue({
      envelope: { sourceMailRef: REF_NEW, to: envelope.to, subject: envelope.subject },
      changed: false,
      adopted: true,
    });
    prepare.mockRejectedValue(expired());
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_OLD,
      envelope,
      renewal: { renew },
    })!;

    const failure = await attempt(adapter).catch((error: unknown) => error);

    expect(renew).toHaveBeenCalledOnce();
    expect(renew).toHaveBeenCalledWith("vault");
    expect(send).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect((failure as EmailDeliveryError).code).toBe("REPLY_SOURCE_REFRESHED");
    expect((failure as EmailDeliveryError).message).toMatch(/Nothing was sent/);
    // The text the person wrote is exactly where they left it.
    expect(typed.body).toBe(WRITTEN);
  });

  it("is reported as refused before any send, so the card never calls it uncertain", async () => {
    const renew = vi.fn().mockResolvedValue({
      envelope: { sourceMailRef: REF_NEW, to: envelope.to, subject: envelope.subject },
      changed: false,
      adopted: true,
    });
    send.mockRejectedValue(expired("REPLY_SOURCE_REF_INVALID"));
    prepare.mockResolvedValue({ actionId: "action-1", senderToken: "s" });
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_OLD,
      envelope,
      renewal: { renew },
    })!;
    let sendStarted = false;

    const failure = await adapter
      .send({
        firebaseIdToken: "fb",
        vaultOwnerToken: "vault",
        draft: typed,
        idempotencyKey: "key-1",
        onSendRequestStarted: () => {
          sendStarted = true;
        },
      })
      .catch((error: unknown) => error);

    // Even a refusal at the send stage is "nothing was sent", never "check Sent Mail".
    const settled = deliveryFailure(failure, sendStarted);
    expect(settled.code).toBe("REPLY_SOURCE_REFRESHED");
    expect(settled.code).not.toBe("EMAIL_ACTION_OUTCOME_UNKNOWN");
  });

  it("says when the original now yields a different recipient or subject", async () => {
    const renew = vi.fn().mockResolvedValue({
      envelope: { sourceMailRef: REF_OLD, to: envelope.to, subject: envelope.subject },
      changed: true,
      adopted: true,
    });
    prepare.mockRejectedValue(expired());
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_OLD,
      envelope,
      renewal: { renew },
    })!;

    const failure = (await attempt(adapter).catch((error: unknown) => error)) as EmailDeliveryError;

    expect(failure.code).toBe("REPLY_SOURCE_REFRESHED");
    expect(failure.message).toMatch(/different reply details/);
    expect(failure.message).toMatch(/Nothing was sent/);
  });

  it.each([
    ["source_unavailable", "REPLY_SOURCE_UNAVAILABLE", /can't be found/],
    ["account_changed", "REPLY_ACCOUNT_CHANGED", /account changed/],
    ["reconnect_required", "GMAIL_READ_PERMISSION_REQUIRED", /Reconnect/],
    ["reply_unavailable", "MAIL_REPLY_UNAVAILABLE", /switched off/],
    ["retryable", "REPLY_SOURCE_RETRYABLE", /Try again/],
    ["network", "REPLY_SOURCE_RETRYABLE", /Try again/],
  ] as const)(
    "when renewal itself is refused (%s) it says why, and still nothing was sent",
    async (reason, code, copy) => {
      const renew = vi.fn().mockRejectedValue(new MailOverviewError(reason));
      prepare.mockRejectedValue(expired());
      const adapter = createSourceBoundEmailReply({
        workflowId: null,
        sourceMailRef: REF_OLD,
        envelope,
        renewal: { renew },
      })!;

      const failure = (await attempt(adapter).catch((error: unknown) => error)) as EmailDeliveryError;

      expect(failure.code).toBe(code);
      expect(failure.message).toMatch(copy);
      expect(failure.message).toMatch(/Nothing was sent/);
      expect(send).not.toHaveBeenCalled();
      expect(typed.body).toBe(WRITTEN);
    },
  );

  it("treats a failure with no way to renew exactly as before", async () => {
    prepare.mockRejectedValue(expired());
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_OLD,
      envelope,
    })!;

    const failure = (await attempt(adapter).catch((error: unknown) => error)) as EmailDeliveryError;

    expect(failure.code).toBe("REPLY_SOURCE_REF_EXPIRED");
    expect(failure.message).toBe("This reply expired. Ask One to prepare it again.");
  });
});

describe("only an expired reference is renewed", () => {
  it("leaves other failures alone, and does not renew on a send that worked", async () => {
    const renew = vi.fn();
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_OLD,
      envelope,
      renewal: { renew },
    })!;

    prepare.mockRejectedValueOnce(
      new EmailDeliveryError("Gmail refused it.", 502, "GMAIL_SEND_FAILED"),
    );
    await expect(attempt(adapter)).rejects.toMatchObject({ code: "GMAIL_SEND_FAILED" });

    prepare.mockResolvedValueOnce({ actionId: "action-1", senderToken: "s" });
    send.mockResolvedValueOnce({ outcomeUnknown: false });
    await expect(attempt(adapter)).resolves.toEqual({ outcomeUnknown: false });

    expect(renew).not.toHaveBeenCalled();
  });

  it("sends the reply against the reference the adapter was given, with the written text", async () => {
    prepare.mockResolvedValue({ actionId: "action-1", senderToken: "s" });
    send.mockResolvedValue({ outcomeUnknown: false });
    const adapter = createSourceBoundEmailReply({
      workflowId: null,
      sourceMailRef: REF_NEW,
      envelope: { ...envelope, sourceMailRef: REF_NEW },
      renewal: { renew: vi.fn() },
    })!;

    await attempt(adapter);

    expect(prepare.mock.calls[0][0].draft).toMatchObject({
      to: "alice@example.com",
      subject: "Re: Invoice",
      sourceMailRef: REF_NEW,
      body: expect.stringContaining("I'll pay this on Friday"),
    });
  });
});
