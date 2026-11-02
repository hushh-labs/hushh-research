import { mocks } from "../fixtures/calendar-agent-page";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

const gmail = vi.hoisted(() => ({
  connect: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/lib/connections/google-connect-in-place", () => ({ connectGmailInPlace: gmail.connect }));
vi.mock("@/lib/services/gmail-receipts-service", () => ({ GmailReceiptsService: { getStatus: gmail.status } }));

describe("Calendar first-time setup Mail step", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.native = false;
    mocks.authLoading = false;
    mocks.ownerId = "calendar-user";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "calendar-user", ownerId: "calendar-user", accountGeneration: 0 });
    mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "shared" });
    mocks.popupAttempt = "";
    mocks.vaultOwnerToken = null;
    mocks.attendance = null;
    useOneConversationSession.getState().clearSession();
    mocks.getIdToken.mockResolvedValue("firebase-token");
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.spyOn(window, "open").mockImplementation(
      () =>
        (mocks.popup = ({
          close: vi.fn(),
          document: { title: "" },
          focus: vi.fn(),
          location: { replace: vi.fn() },
          sessionStorage: {
            setItem: vi.fn((_key: string, value: string) => { mocks.popupAttempt = value; }),
            getItem: vi.fn(() => mocks.popupAttempt || null),
          },
        }) as unknown as Window),
    );
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    mocks.startConnect.mockResolvedValue({ authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}` });
    gmail.status.mockResolvedValue({ connected: false, send_permission_granted: false });
  });

  const connectCalendar = async () => {
    render(<CalendarAgentPage />);
    const button = await screen.findByRole("button", { name: "Connect your calendar" });
    await waitFor(() => expect(button).toBeEnabled());
    // Every permission is listed before Google is opened.
    expect(screen.getByTestId("calendar-setup-permissions")).toHaveTextContent(/Send meeting emails only after you review them/);
    fireEvent.click(button);
    await waitFor(() => expect((mocks.popup as unknown as { location: { replace: ReturnType<typeof vi.fn> } }).location.replace).toHaveBeenCalled());
    const attempt = JSON.parse(mocks.popupAttempt);
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, source: mocks.popup,
      data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: attempt.attemptId, service: "calendar", outcome: "succeeded" },
    })));
  };

  it("asks for Mail send access right after Calendar and leaves once it is granted", async () => {
    gmail.connect.mockReturnValue({ surface: "window", result: Promise.resolve("connected") });
    await connectCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "Allow Mail" }));
    expect(gmail.connect).toHaveBeenCalledWith(expect.objectContaining({ purpose: "send" }));
    gmail.status.mockResolvedValue({ connected: true, send_permission_granted: true });
    await waitFor(() => expect(screen.queryByTestId("calendar-mail-step")).toBeNull());
  });

  it("skips the step when Mail sending is already allowed", async () => {
    gmail.status.mockResolvedValue({ connected: true, send_permission_granted: true });
    await connectCalendar();
    await waitFor(() => expect(screen.queryByTestId("calendar-mail-step")).toBeNull());
    expect(gmail.connect).not.toHaveBeenCalled();
  });

  it("keeps the step open when Mail is not allowed so the person can retry", async () => {
    gmail.connect.mockReturnValue({ surface: "window", result: Promise.resolve("not_connected") });
    await connectCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "Allow Mail" }));
    await waitFor(() => expect(gmail.connect).toHaveBeenCalled());
    expect(screen.getByTestId("calendar-mail-step")).toBeTruthy();
  });
});

afterEach(() => publishValidatedAuthSessionPrincipal(null));
