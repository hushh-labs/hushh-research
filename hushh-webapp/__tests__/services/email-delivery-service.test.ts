import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn() },
}));

import {
  EmailDeliveryError,
  EmailDeliveryService,
} from "@/lib/services/email-delivery-service";
import { ApiService } from "@/lib/services/api-service";

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ message_id: "sent-1" }), { status: 200 }));
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

    await EmailDeliveryService.send({ ...auth, draft, actionId: prepared.actionId, attachmentToken: prepared.attachmentToken });
    const sendBody = JSON.parse(String(vi.mocked(ApiService.apiFetch).mock.calls[1][1]?.body));
    expect(sendBody.attachment_token).toBe("sealed-review-token");
    expect(sendBody).not.toHaveProperty("drive_attachment");
    expect(sendBody).not.toHaveProperty("driveFileId");
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

  it("maps a disabled Gmail delivery connection to a safe reconnect error", async () => {
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
      message: "Reconnect Mail to finish enabling mail sending.",
      needsGmailReconnect: true,
    });
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
