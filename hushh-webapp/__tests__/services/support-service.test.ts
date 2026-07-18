import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
  },
}));

import { SupportService } from "@/lib/services/support-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SupportService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the parsed payload on success", async () => {
    const payload = {
      accepted: true,
      delivery_mode: "live",
      recipient: "support@hushh.ai",
      intended_recipient: "support@hushh.ai",
      from_email: "user@example.com",
      message_id: "msg-123",
    };

    mockApiFetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await SupportService.submitMessage({
      idToken: "token",
      userId: "user-1",
      kind: "support_request",
      subject: "Need help",
      message: "Testing",
    });

    expect(result).toEqual(payload);
  });

  it("sends the correct request payload and authorization header", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        accepted: true,
        delivery_mode: "test",
        recipient: "support@hushh.ai",
        intended_recipient: "support@hushh.ai",
        from_email: "user@example.com",
      })
    );

    await SupportService.submitMessage({
      idToken: "vault-token",
      userId: "user-123",
      kind: "bug_report",
      subject: "Bug",
      message: "Something broke",
      userEmail: "user@example.com",
      userDisplayName: "Test User",
      persona: "kai",
      pageUrl: "/profile",
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    const [path, options] = mockApiFetch.mock.calls[0];

    expect(path).toBe("/api/kai/support/message");

    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("uses detail.message when present", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: {
            message: "Support queue unavailable",
          },
        },
        503
      )
    );

    await expect(
      SupportService.submitMessage({
        idToken: "token",
        userId: "user-1",
        kind: "support_request",
        subject: "Help",
        message: "Test",
      })
    ).rejects.toThrow("Support queue unavailable");
  });

  it("uses detail string when present", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: "Invalid request",
        },
        400
      )
    );

    await expect(
      SupportService.submitMessage({
        idToken: "token",
        userId: "user-1",
        kind: "support_request",
        subject: "Help",
        message: "Test",
      })
    ).rejects.toThrow("Invalid request");
  });

  it("uses top-level error when present", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Authentication failed",
        },
        401
      )
    );

    await expect(
      SupportService.submitMessage({
        idToken: "token",
        userId: "user-1",
        kind: "support_request",
        subject: "Help",
        message: "Test",
      })
    ).rejects.toThrow("Authentication failed");
  });

  it("falls back to status code when no error message exists", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(
      SupportService.submitMessage({
        idToken: "token",
        userId: "user-1",
        kind: "support_request",
        subject: "Help",
        message: "Test",
      })
    ).rejects.toThrow("Failed to send support message: 500");
  });
});
