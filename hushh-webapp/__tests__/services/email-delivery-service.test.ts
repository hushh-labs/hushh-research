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
      message: "Reconnect Gmail to grant email sending permission.",
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
