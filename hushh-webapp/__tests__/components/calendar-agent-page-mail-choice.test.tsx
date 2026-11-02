import { mocks } from "../fixtures/calendar-agent-page";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

describe("CalendarAgentPage optional email choice", () => {
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
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  const waitForConnectButton = async () => {
    const button = await screen.findByRole("button", { name: "Connect your calendar" });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };

  it("offers the optional email choice on a first connection without changing the Calendar request", async () => {
    window.localStorage.clear();
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));
    render(<CalendarAgentPage />);
    const connect = await waitForConnectButton();
    const choice = screen.getByRole("checkbox", { name: /Watch my email for meeting requests and reminders\./ });
    // Optional and off until the owner turns it on; Calendar alone is the default.
    expect(choice).not.toBeChecked();
    fireEvent.click(choice);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        accessLevel: "manage",
        includeMeetingFiles: true,
      }),
    );
    const remembered = JSON.parse(window.localStorage.getItem("hushh.calendar.mailChoice.v1") || "null");
    expect(remembered).toMatchObject({ ownerId: "calendar-user", knownAccountIds: [] });
  });

  it("does not offer or remember the email choice when only renewing Google access", async () => {
    window.localStorage.setItem("hushh.calendar.mailChoice.v1", JSON.stringify({ ownerId: "calendar-user", knownAccountIds: [], at: Date.now() }));
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "needs_reauth", scope_csv: "" });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));
    render(<CalendarAgentPage />);
    const connect = await waitForConnectButton();
    expect(screen.queryByRole("checkbox", { name: /Find meeting requests/ })).toBeNull();
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.startConnect).toHaveBeenCalled());
    expect(window.localStorage.getItem("hushh.calendar.mailChoice.v1")).toBeNull();
  });
});
