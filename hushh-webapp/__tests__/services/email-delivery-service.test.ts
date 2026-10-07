import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn() },
}));

import {
  EmailDeliveryError,
  EmailDeliveryService,
} from "@/lib/services/email-delivery-service";
import { ApiService } from "@/lib/services/api-service";

const AUTH = { firebaseIdToken: "firebase-token", vaultOwnerToken: "vault-owner-token" };
const SOURCE_MAIL_REF = "rs1.nX4-qL9_c2VhbGVkLXJlcGx5LXNvdXJjZQ";
const WORKFLOW_ID = "6f1c2b9e-0d4a-4e8b-9a37-1c5d7e9f2b40";
const ACTION_ID = "3f0c9a52-6b1e-4d8a-9c47-2e5b8f1d0a63";

/** What the voice reply card hands the service: the body only, bound by the sealed ref. */
const replyDraft = () => ({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "  Friday works.\nSee you at noon.",
  htmlBody: "<p>Friday works.<br>See you at noon.</p>",
  sourceMailRef: SOURCE_MAIL_REF,
});

function requestBody(call: number): Record<string, unknown> {
  return JSON.parse(String(vi.mocked(ApiService.apiFetch).mock.calls[call]?.[1]?.body));
}

describe("EmailDeliveryService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps explicit draft fields and both short-lived auth credentials at the delivery boundary", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ action_id: "email_action_1", expires_at: "2026-08-26T00:00:00Z" }), {
        status: 200,
      }),
    );

    await EmailDeliveryService.prepare({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-owner-token",
      idempotencyKey: "idem-1",
      draft: { to: "to@example.com", cc: "cc@example.com", bcc: "", subject: "Hello", body: "Body" },
    });

    expect(ApiService.apiFetch).toHaveBeenCalledWith("/api/one/email/prepare", {
      method: "POST",
      headers: {
        Authorization: "Bearer firebase-token",
        "X-Hushh-Consent": "Bearer vault-owner-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: "to@example.com",
        cc: "cc@example.com",
        bcc: "",
        subject: "Hello",
        body: "Body",
        idempotency_key: "idem-1",
      }),
    });
  });

  it("carries the reviewed rich representation alongside the plain-text fallback", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ action_id: "email_action_1", expires_at: "2026-08-26T00:00:00Z" }), {
        status: 200,
      }),
    );

    await EmailDeliveryService.prepare({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-owner-token",
      idempotencyKey: "idem-2",
      draft: {
        to: "to@example.com",
        cc: "",
        bcc: "",
        subject: "Hello",
        body: "**Welcome**",
        htmlBody: "<p><strong>Welcome</strong></p>",
      },
    });

    expect(JSON.parse(String(vi.mocked(ApiService.apiFetch).mock.calls[0][1]?.body))).toMatchObject({
      html_body: "<p><strong>Welcome</strong></p>",
      body: "**Welcome**",
    });
  });

  it("sends only a Drive file reference for review and a bound token after confirmation", async () => {
    vi.mocked(ApiService.apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_id: "drive-action",
        attachment_token: "sealed-review-token",
        drive_attachment: {
          filename: "Brief.pdf",
          mime_type: "application/pdf",
          size: 2048,
          source_account_label: "Connected Drive account",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "sent", action_id: "drive-action", message_id: "sent-1" }), { status: 200 }));
    const auth = { firebaseIdToken: "firebase-token", vaultOwnerToken: "vault-owner-token" };
    const draft = {
      to: "pat@example.com", cc: "", bcc: "", subject: "Brief", body: "See attachment",
      driveFileId: "drive-file-1",
    };

    const prepared = await EmailDeliveryService.prepare({ ...auth, draft, idempotencyKey: "review-key-123456" });
    expect(prepared.driveAttachment).toMatchObject({ filename: "Brief.pdf", size: 2048 });
    expect(JSON.parse(String(vi.mocked(ApiService.apiFetch).mock.calls[0][1]?.body))).toMatchObject({
      drive_attachment: { file_id: "drive-file-1" },
    });

    const sent = await EmailDeliveryService.send({ ...auth, draft, actionId: prepared.actionId, attachmentToken: prepared.attachmentToken });
    const sendBody = JSON.parse(String(vi.mocked(ApiService.apiFetch).mock.calls[1][1]?.body));
    expect(sendBody.attachment_token).toBe("sealed-review-token");
    expect(sendBody).not.toHaveProperty("drive_attachment");
    expect(sendBody).not.toHaveProperty("driveFileId");
    expect(sent).toMatchObject({ actionId: "drive-action", messageId: "sent-1" });
  });

  it("binds a reply by its sealed source ref alone on prepare and send, and returns the recorded send action", async () => {
    vi.mocked(ApiService.apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ action_id: ACTION_ID, expires_at: "2026-10-05T00:10:00Z" }), {
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_id: ACTION_ID,
        message_id: "msg-1",
        thread_id: "thread-1",
        state: "sent",
        outcome_unknown: false,
      }), { status: 200 }));

    const prepared = await EmailDeliveryService.prepare({ ...AUTH, draft: replyDraft(), idempotencyKey: "idem-reply" });
    const sent = await EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: prepared.actionId });

    expect(vi.mocked(ApiService.apiFetch).mock.calls.map(([path]) => path)).toEqual([
      "/api/one/email/prepare",
      "/api/one/email/send",
    ]);
    expect(requestBody(0)).toEqual({
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: "  Friday works.\nSee you at noon.",
      html_body: "<p>Friday works.<br>See you at noon.</p>",
      idempotency_key: "idem-reply",
      source_mail_ref: SOURCE_MAIL_REF,
    });
    expect(requestBody(1)).toEqual({
      action_id: ACTION_ID,
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: "  Friday works.\nSee you at noon.",
      html_body: "<p>Friday works.<br>See you at noon.</p>",
      source_mail_ref: SOURCE_MAIL_REF,
    });
    expect(sent).toEqual({ actionId: ACTION_ID, messageId: "msg-1", threadId: "thread-1", outcomeUnknown: false });
  });

  it("refuses a draft bound to two original emails before any request leaves the device", async () => {
    const draft = { ...replyDraft(), sourceWorkflowId: WORKFLOW_ID };
    const attempts: Array<() => Promise<unknown>> = [
      () => EmailDeliveryService.prepare({ ...AUTH, draft, idempotencyKey: "idem-reply" }),
      () => EmailDeliveryService.send({ ...AUTH, draft, actionId: ACTION_ID }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(() => null, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({ status: 400 });
    }
    expect(ApiService.apiFetch).not.toHaveBeenCalled();

    // Control: the information-request reply still carries its own single binding.
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ action_id: ACTION_ID }), { status: 200 }),
    );
    await EmailDeliveryService.prepare({
      ...AUTH,
      draft: { ...draft, sourceMailRef: undefined },
      idempotencyKey: "idem-reply",
    });
    expect(requestBody(0)).toMatchObject({ source_workflow_id: WORKFLOW_ID });
    expect(requestBody(0)).not.toHaveProperty("source_mail_ref");
  });

  it("maps reply-binding failures to local copy without echoing the server's detail", async () => {
    const cases = [
      ["REPLY_SOURCE_CHANGED", "The original email or your Mail connection changed. Ask One to prepare the reply again."],
      ["REPLY_SOURCE_REF_EXPIRED", "This reply expired. Ask One to prepare it again."],
    ] as const;
    for (const [code, message] of cases) {
      vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code, message: "Re: Q3 numbers <maya@example.com>" } }), {
          status: 409,
        }),
      );
      await expect(
        EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: ACTION_ID }),
      ).rejects.toMatchObject({ code, status: 409, message });
    }
  });

  it("maps a missing Gmail send scope to a safe reconnect error without echoing server detail", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "GMAIL_SEND_PERMISSION_REQUIRED", message: "do not expose" } }), {
        status: 409,
      }),
    );

    await expect(
      EmailDeliveryService.draft({
        firebaseIdToken: "firebase-token",
        vaultOwnerToken: "vault-owner-token",
        instruction: "draft something",
      }),
    ).rejects.toMatchObject<Partial<EmailDeliveryError>>({
      code: "GMAIL_SEND_PERMISSION_REQUIRED",
      message: "Reconnect Mail to grant mail sending permission.",
    });
  });

  it("directs a disabled Gmail sender to enable sending without reconnecting", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "GMAIL_SEND_DISABLED", message: "do not expose" } }), {
        status: 409,
      }),
    );

    await expect(
      EmailDeliveryService.prepare({
        firebaseIdToken: "firebase-token",
        vaultOwnerToken: "vault-owner-token",
        idempotencyKey: "idem-3",
        draft: { to: "to@example.com", cc: "", bcc: "", subject: "Hello", body: "Body" },
      }),
    ).rejects.toMatchObject<Partial<EmailDeliveryError>>({
      code: "GMAIL_SEND_DISABLED",
      message: "Turn on Gmail sending to continue. Your draft is still here.",
      needsGmailReconnect: false,
      needsGmailSendingEnabled: true,
    });
  });

  it("requires a sent state and matching action before reporting success", async () => {
    for (const response of [
      {}, { action_id: ACTION_ID }, { state: "prepared", action_id: ACTION_ID },
      { state: "sent", action_id: "another-action" },
      { state: "sent", action_id: ACTION_ID, outcome_unknown: true },
    ]) {
      vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
      await expect(EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: ACTION_ID }))
        .rejects.toMatchObject({ code: "EMAIL_ACTION_OUTCOME_UNKNOWN" });
    }
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ state: "sent", action_id: ACTION_ID }), { status: 200 }));
    await expect(EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: ACTION_ID, senderToken: "bound-sender", draftRef: "draft_reference_1234", revision: 2 }))
      .resolves.toMatchObject({ actionId: ACTION_ID, outcomeUnknown: false, messageId: null });
    expect(requestBody(5)).toMatchObject({ sender_token: "bound-sender", draft_ref: "draft_reference_1234", revision: 2 });
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ state: "outcome_unknown", action_id: ACTION_ID }), { status: 200 }));
    await expect(EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: ACTION_ID }))
      .resolves.toMatchObject({ outcomeUnknown: true });
  });

  it("distinguishes Gmail authorization failures from owner authorization and temporary outages", async () => {
    const cases = [
      { code: "GMAIL_NOT_READY", status: 401, reconnect: true },
      { code: "GMAIL_NOT_READY", status: 403, reconnect: true },
      { code: "GMAIL_SEND_NOT_READY", status: 401, reconnect: true },
      { code: "GMAIL_SEND_NOT_READY", status: 403, reconnect: true },
      { code: "GMAIL_DELIVERY_USER_MISMATCH", status: 403, reconnect: false },
      { code: null, status: 401, reconnect: false },
      { code: "GMAIL_NOT_READY", status: 503, reconnect: false },
    ];
    for (const { code, status, reconnect } of cases) {
      vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code, message: "private provider detail" } }), { status }),
      );
      const error = await EmailDeliveryService.send({ ...AUTH, draft: replyDraft(), actionId: ACTION_ID })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({ code, status, needsGmailReconnect: reconnect });
      expect((error as EmailDeliveryError).message).not.toContain("private provider detail");
      expect((error as EmailDeliveryError).message).toBe(
        reconnect
          ? "Reconnect Mail to continue."
          : status === 503
            ? "Mail could not be completed. Please review the draft and try again."
            : "Unlock your vault and try again.",
      );
    }
  });

  it("renders structured recipient lists from the drafting boundary into editable fields", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          to: ["to@example.com"],
          cc: ["cc@example.com"],
          bcc: [],
          subject: "Hello",
          body: "Body",
          missing_details: [],
        }),
        { status: 200 },
      ),
    );

    await expect(
      EmailDeliveryService.draft({
        firebaseIdToken: "firebase-token",
        vaultOwnerToken: "vault-owner-token",
        instruction: "Write a hello.",
      }),
    ).resolves.toMatchObject({
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "",
    });
  });
});
