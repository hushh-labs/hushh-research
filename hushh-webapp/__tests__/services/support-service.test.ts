import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mocks.apiFetch,
  },
}));

import { SupportService } from "@/lib/services/support-service";

describe("SupportService.submitMessage", () => {
  it("maps backend/internal failures to a safe support message", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({
        detail: {
          message: "SMTPAuthenticationError: login failed at support relay 10.0.0.12",
        },
      }),
    });

    await expect(
      SupportService.submitMessage({
        idToken: "token-abc",
        userId: "user-123",
        kind: "support_request",
        subject: "Need help",
        message: "This flow is stuck for me.",
      })
    ).rejects.toThrow("We couldn't send your message right now. Please try again.");
  });

  it("returns a friendly rate-limit message instead of raw backend detail", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn().mockResolvedValue({
        detail: "Too many support_email_service requests for user-123",
      }),
    });

    await expect(
      SupportService.submitMessage({
        idToken: "token-abc",
        userId: "user-123",
        kind: "bug_report",
        subject: "Bug report",
        message: "Steps to reproduce are attached here.",
      })
    ).rejects.toThrow("You're sending messages too quickly. Please wait a minute and try again.");
  });
});
