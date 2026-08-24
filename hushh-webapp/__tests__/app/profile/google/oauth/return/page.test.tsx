import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchGet: vi.fn(),
  completeConnect: vi.fn(),
  completeEmailConnect: vi.fn(),
  consumeSetupReturn: vi.fn(),
  consumeEmailReturn: vi.fn(),
  getIdToken: vi.fn(),
  readPopupAttempt: vi.fn(),
  settlePopup: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => ({ get: mocks.searchGet }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "calendar-user", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/lib/calendar/calendar-oauth-journey", () => ({
  consumeCalendarSetupOAuthReturn: mocks.consumeSetupReturn,
}));

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { completeConnect: mocks.completeConnect },
}));

vi.mock("@/lib/services/google-email-send-service", () => ({
  GoogleEmailSendService: { completeConnect: mocks.completeEmailConnect },
}));

vi.mock("@/components/gmail/gmail-send-access-card", () => ({
  consumeGoogleEmailSendReturn: mocks.consumeEmailReturn,
}));

vi.mock("@/lib/google/google-oauth-popup", () => ({
  readGoogleOAuthPopupAttempt: mocks.readPopupAttempt,
  settleGoogleOAuthPopup: mocks.settlePopup,
}));

vi.mock("@/components/email/email-agent-page", () => ({
  EmailAgentPage: () => <div>Finishing Email connection…</div>,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));

import GoogleOAuthReturnPage from "@/app/profile/google/oauth/return/page";

describe("GoogleOAuthReturnPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIdToken.mockResolvedValue("firebase-token");
    mocks.completeConnect.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      access_level: "manage",
      scope_csv: "calendar.events calendar.freebusy",
    });
    mocks.completeEmailConnect.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      access_level: "send",
      scope_csv:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    });
    mocks.consumeSetupReturn.mockReturnValue(false);
    mocks.consumeEmailReturn.mockReturnValue(null);
    mocks.readPopupAttempt.mockReturnValue(null);
    mocks.searchGet.mockImplementation((key: string) =>
      key === "code" ? "google-code" : key === "state" ? "google-state" : null,
    );
  });

  it("settles the encrypted connection before landing on the Calendar workspace", async () => {
    render(<GoogleOAuthReturnPage />);

    expect(screen.getByText("Finishing Calendar connection…")).toBeTruthy();
    await waitFor(() =>
      expect(mocks.completeConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        code: "google-code",
        state: "google-state",
      }),
    );
    expect(mocks.replace).toHaveBeenCalledWith("/one/calendar");
  });

  it("only returns to Calendar setup when that exact setup journey initiated OAuth", async () => {
    mocks.consumeSetupReturn.mockReturnValue(true);

    render(<GoogleOAuthReturnPage />);

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup/calendar"),
    );
  });

  it("returns Gmail-send OAuth to the Email agent instead of Calendar", async () => {
    mocks.readPopupAttempt.mockReturnValue({
      version: 1,
      attemptId: "gmail-attempt-123",
      service: "gmail_send",
      startedAt: Date.now(),
    });

    render(<GoogleOAuthReturnPage />);

    expect(screen.getByText("Finishing Email connection…")).toBeTruthy();
    await waitFor(() =>
      expect(mocks.completeEmailConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        code: "google-code",
        state: "google-state",
      }),
    );
    expect(mocks.settlePopup).toHaveBeenCalledWith(
      expect.objectContaining({ service: "gmail_send" }),
      "succeeded",
    );
    expect(mocks.completeConnect).not.toHaveBeenCalled();
  });
});
