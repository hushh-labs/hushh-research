import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  getStatus: vi.fn(),
  setSendEnabled: vi.fn(),
  startConnect: vi.fn(),
  createAttempt: vi.fn(),
  openPopup: vi.fn(),
  navigatePopup: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "gmail-user", email: "owner@example.com", getIdToken: mocks.getIdToken },
  }),
}));

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    getStatus: mocks.getStatus,
    setSendEnabled: mocks.setSendEnabled,
    startConnect: mocks.startConnect,
  },
}));

vi.mock("@/lib/profile/gmail-oauth-popup", () => ({
  clearGmailOAuthPopupAttempt: vi.fn(),
  createGmailOAuthPopupAttempt: mocks.createAttempt,
  isGmailOAuthPopupSettlement: () => false,
  navigateGmailOAuthPopup: mocks.navigatePopup,
  openGmailOAuthPopup: mocks.openPopup,
  readGmailOAuthPopupSettlementFallback: () => null,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { error: vi.fn(), success: vi.fn() },
}));

import { GmailSendAccessCard } from "@/components/gmail/gmail-send-access-card";

describe("GmailSendAccessCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIdToken.mockResolvedValue("firebase-token");
    mocks.getStatus.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
      send_permission_granted: true,
      send_enabled: false,
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });
  });

  it("enables sending locally without starting another Google OAuth flow", async () => {
    mocks.setSendEnabled.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
      send_permission_granted: true,
      send_enabled: true,
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });

    render(<GmailSendAccessCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow send email" }));

    await waitFor(() =>
      expect(mocks.setSendEnabled).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "gmail-user",
        enabled: true,
      }),
    );
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });

  it("offers a single reconnect only for a pre-existing read-only connection", async () => {
    mocks.getStatus.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "https://www.googleapis.com/auth/gmail.readonly",
      send_permission_granted: false,
      send_enabled: false,
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });
    mocks.createAttempt.mockReturnValue({ attemptId: "gmail-attempt", startedAt: Date.now() });
    const popup = { close: vi.fn() } as unknown as Window;
    mocks.openPopup.mockReturnValue(popup);
    mocks.startConnect.mockResolvedValue({ authorize_url: "https://accounts.google.com/example" });

    render(<GmailSendAccessCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Gmail" }));

    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "gmail-user",
        loginHint: "owner@example.com",
        includeGrantedScopes: true,
      }),
    );
    expect(mocks.navigatePopup).toHaveBeenCalledWith(
      popup,
      "https://accounts.google.com/example",
    );
  });

  it("keeps sending unavailable while the service schema update is pending", async () => {
    mocks.getStatus.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
      send_permission_granted: true,
      send_enabled: false,
      send_toggle_available: false,
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });

    render(<GmailSendAccessCard />);

    expect(
      await screen.findByRole("button", { name: "Email sending is updating" }),
    ).toBeDisabled();
    expect(mocks.setSendEnabled).not.toHaveBeenCalled();
  });
});
