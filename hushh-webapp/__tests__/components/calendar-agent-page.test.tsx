import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import type { CalendarAttendanceHandoff, CalendarInvitationHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  startConnect: vi.fn(),
  startNativeConnect: vi.fn(),
  completeNativeConnect: vi.fn(),
  disconnect: vi.fn(),
  getIdToken: vi.fn(),
  navigateToAgentChat: vi.fn(),
  trackEvent: vi.fn(),
  connectCalendar: vi.fn(),
  privateConnect: vi.fn(),
  ownerId: "calendar-user" as string | null,
  native: false,
  authLoading: false,
  popup: null as Window | null,
  popupAttempt: "",
  vaultOwnerToken: null as string | null,
  attendance: null as CalendarAttendanceHandoff | null,
}));

// Connection/OAuth owner tests use the workspace composition seam; its real
// event, keyboard and attendance behavior is covered in the connected suite.
vi.mock("@/components/calendar/calendar-connected-workspace", () => ({
  CalendarConnectedWorkspace: ({ status, busy, onChat, onDisconnect, onConnect, onAddAccount }: { status: { connected: boolean; google_email?: string }; busy: boolean; onChat: (prompt?: string, slot?: CalendarSlotHandoff, invitation?: CalendarInvitationHandoff, attendance?: CalendarAttendanceHandoff) => void; onDisconnect: () => void; onAddAccount?: () => void; onConnect: (access: "read" | "manage", includeList: boolean) => void }) => <main><h1>Calendar</h1><p>{status.google_email}</p>{status.connected && <p>Connected</p>}<p>{mocks.vaultOwnerToken ? "Calendar reads authorized" : "Calendar session unavailable"}</p><button disabled={busy} onClick={() => onChat()}>Try Calendar Agent with One</button><button disabled={busy} onClick={() => onChat("Find free time on 2026-10-15 from 10:00 to 16:00 in Asia/Kolkata for 30 minutes.")}>Ask with current window</button><button onClick={() => onChat(undefined, { ownerId: "calendar-user", accountEmail: "calendar-user@example.com", date: "2030-10-15", windowStart: "2030-10-15T10:00:00Z", windowEnd: "2030-10-15T12:00:00Z", durationMinutes: 60, timeZone: "Europe/London" })}>Select free window</button><button onClick={() => { if (mocks.attendance) onChat(undefined, undefined, undefined, mocks.attendance); }}>Finish invitation in One</button>{onAddAccount && <button disabled={busy} onClick={onAddAccount}>Add Calendar account</button>}<button disabled={busy} onClick={onDisconnect}>Disconnect Calendar</button><button disabled={busy} onClick={() => onConnect("manage", true)}>Review Calendar scheduling</button></main>,
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => mocks.native },
  };
});
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectCalendar: mocks.connectCalendar },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.trackEvent }));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: mocks.navigateToAgentChat,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: mocks.ownerId,
    user: mocks.ownerId
      ? { uid: mocks.ownerId, email: `${mocks.ownerId}@example.com`, displayName: "Calendar owner", getIdToken: mocks.getIdToken }
      : null,
    loading: mocks.authLoading,
  }),
}));

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    status: mocks.status,
    startConnect: mocks.startConnect,
    startNativeConnect: mocks.startNativeConnect,
    completeNativeConnect: mocks.completeNativeConnect,
    disconnect: mocks.disconnect,
  },
}));

// These Calendar cases exercise the explicitly selected Shared runtime.
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.getPersonalAgentStatus },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () => mocks.ownerId ? { uid: mocks.ownerId } : null,
  },
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: mocks.vaultOwnerToken ? "synthetic-vault-key" : null, vaultOwnerToken: mocks.vaultOwnerToken }),
}));

vi.mock("@/lib/one/google-native-connect", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/one/google-native-connect")>(),
  connectGoogleConnector: mocks.privateConnect,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), promise: vi.fn() } }));

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

describe("CalendarAgentPage", () => {
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
    vi.spyOn(window, "open").mockImplementation(
      () =>
        (mocks.popup = ({
          close: vi.fn(),
          document: { title: "" },
          focus: vi.fn(),
          location: { replace: vi.fn() },
          sessionStorage: {
            setItem: vi.fn((_key: string, value: string) => {
              mocks.popupAttempt = value;
            }),
            getItem: vi.fn(() => mocks.popupAttempt || null),
          },
        }) as unknown as Window),
    );
  });

  const waitForConnectButton = async () => {
    const button = await screen.findByRole("button", { name: "Connect your calendar" });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };

  const waitForConsentWindow = () =>
    waitFor(() =>
      expect(
        (mocks.popup as unknown as { location: { replace: ReturnType<typeof vi.fn> } })
          .location.replace,
      ).toHaveBeenCalled(),
    );

  it("requests read-only access before an owner enables Calendar scheduling", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));

    render(<CalendarAgentPage />);

    const connect = await waitForConnectButton();
    fireEvent.click(connect);

    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        accessLevel: "read",
      }),
    );
    expect(screen.queryByRole("button", { name: "Enable scheduling" })).toBeNull();
  });

  it("opens the connected workspace with the existing chat and disconnect handlers", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "manage",
      scope_csv: "calendar.events calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText("owner@example.com");
    const chat = screen.getByRole("button", {
      name: "Try Calendar Agent with One",
    });
    expect(chat).toBeTruthy();
    expect(chat.querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable scheduling" })).toBeNull();

    fireEvent.click(chat);
    expect(mocks.navigateToAgentChat).toHaveBeenCalledWith();
  });

  it("lets a connected private owner review and cancel replacing legacy Google access", async () => {
    mocks.vaultOwnerToken = "synthetic-owner-capability";
    mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "byoc" });
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
    const reviewed = vi.fn();
    mocks.privateConnect.mockImplementation(async (_service, options) => {
      const approved = await options.confirmLegacyTransition({ services: ["calendar"], scope: "all_google_project_grants" });
      reviewed(approved);
      return { ok: false, code: "SIGN_IN_CANCELLED" };
    });
    render(<CalendarAgentPage />);
    const upgrade = await screen.findByRole("button", { name: "Review Calendar scheduling" });
    fireEvent.click(upgrade);
    await screen.findByRole("dialog", { name: "Replace Google access?" });
    expect(reviewed).not.toHaveBeenCalled();
    expect(mocks.startConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(reviewed).toHaveBeenCalledExactlyOnceWith(false));
    await waitFor(() => expect(upgrade).not.toBeDisabled());
    expect(screen.queryByRole("dialog", { name: "Replace Google access?" })).toBeNull();
    expect(mocks.privateConnect).toHaveBeenCalledOnce();
  });

  it("keeps additional accounts available after the default Calendar disconnects", async () => {
    const second = { account_id: "second", google_email: "second@example.com", status: "connected" as const, connected: true, access_level: "manage" as const, calendar_list_access: true };
    mocks.status.mockResolvedValue({
      configured: true, connected: true, status: "connected", google_email: "default@example.com",
      access_level: "manage", scope_csv: "", accounts: [
        { account_id: "default", google_email: "default@example.com", status: "connected", connected: true, access_level: "manage", calendar_list_access: true }, second,
      ],
    });
    mocks.disconnect.mockResolvedValue({
      configured: true, connected: false, status: "disconnected", google_email: null,
      access_level: null, scope_csv: "", accounts: [second],
    });

    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));

    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Add Calendar account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Calendar Agent with One" })).toBeTruthy();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
  });

  it("opens One chat for a connected read-only Calendar", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText("owner@example.com");
    expect(screen.queryByRole("button", { name: /Reconnect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable scheduling" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try Calendar Agent with One" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Try Calendar Agent with One" }),
    );
    expect(mocks.navigateToAgentChat).toHaveBeenCalledWith();
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });

  it("uses the existing One session without presenting Calendar credentials", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", google_email: "owner@example.com", access_level: "read", scope_csv: "" });
    mocks.vaultOwnerToken = "existing-one-owner-token";
    render(<CalendarAgentPage />);
    expect(await screen.findByText("Calendar reads authorized")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlock/i })).toBeNull();
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(mocks.startConnect).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("accepts shared session recovery without a Calendar unlock action", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", google_email: "owner@example.com", access_level: "read", scope_csv: "" });
    const view = render(<CalendarAgentPage />);
    expect(await screen.findByText("Calendar session unavailable")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlock/i })).toBeNull();
    mocks.vaultOwnerToken = "recovered-one-owner-token";
    view.rerender(<CalendarAgentPage />);
    expect(screen.getByText("Calendar reads authorized")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });

  it("hands the selected Calendar window to One without replacing it with the generic prompt", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", google_email: "owner@example.com", access_level: "read", scope_csv: "" });
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask with current window" }));

    expect(useOneConversationSession.getState().pendingHandoff).toMatchObject({ reason: "user_requested", transcript: "Find free time on 2026-10-15 from 10:00 to 16:00 in Asia/Kolkata for 30 minutes." });
    expect(mocks.navigateToAgentChat).toHaveBeenCalledOnce();
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });

  it("hands the confirmed invitation outcome to One without starting a calendar summary", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", google_email: "owner@example.com", access_level: "manage", scope_csv: "" });
    mocks.attendance = {
      ownerId: "calendar-user",
      epoch: snapshotVaultSessionEpoch(),
      title: "Client Sync",
      recipient: "organizer@example.com",
      outcome: Promise.resolve({ result: { calendar: "declined", email: "sent", calendar_error: null, email_error: null } }),
    };
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish invitation in One" }));

    const handoff = useOneConversationSession.getState().pendingHandoff;
    expect(handoff?.calendarAttendance).toBe(mocks.attendance);
    expect(handoff?.transcript).toBeUndefined();
    expect(mocks.navigateToAgentChat).toHaveBeenCalledOnce();
  });

  it("keeps the Calendar connection surface focused on connection", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });

    render(<CalendarAgentPage journeyVariant="onboarding" />);

    expect(
      await screen.findByRole("heading", {
        name: "Bring your schedule into One.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Try asking One")).toBeNull();
    expect(screen.queryByText(/Summarize my calendar for this week/)).toBeNull();
  });

  it.each([false, true])("returns to the illustration when Google authorization has lapsed (raw connected=%s)", async (rawConnected) => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: rawConnected,
      status: "needs_reauth",
      scope_csv: "",
    });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));

    render(<CalendarAgentPage />);

    await screen.findByText("Google authorization needs to be refreshed.");
    expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try Calendar Agent with One" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect Calendar" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Connect your calendar" }),
    );
    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        accessLevel: "read",
      }),
    );
  });

  it.each(["workspace", "onboarding"] as const)("shows the illustration on a disconnected %s visit", async (journeyVariant) => {
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    render(<CalendarAgentPage journeyVariant={journeyVariant} />);
    const connect = await waitForConnectButton();
    expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect Calendar" })).toBeNull();
    expect(connect.getAttribute("data-voice-control-id")).toBe("open_calendar_connector");
    expect(connect.getAttribute("data-voice-action-id")).toBe(
      journeyVariant === "onboarding" ? "setup.connect_calendar" : null,
    );
  });

  it.each([
    ["workspace", "disconnected"], ["workspace", "connected"],
    ["onboarding", "disconnected"], ["onboarding", "connected"],
  ] as const)("keeps %s neutral until status resolves to %s", async (journeyVariant, connectionState) => {
    let resolveStatus!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    render(<CalendarAgentPage journeyVariant={journeyVariant} />);
    expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect Google Calendar" })).toBeNull();
    await waitFor(() => expect(mocks.status).toHaveBeenCalledOnce());
    expect(mocks.startConnect).not.toHaveBeenCalled();
    expect(mocks.startNativeConnect).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    await act(async () => resolveStatus({ configured: true, connected: connectionState === "connected", status: connectionState, access_level: "read", scope_csv: "" }));
    if (connectionState === "connected") {
      expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
      expect(screen.getByRole("heading", { name: journeyVariant === "workspace" ? "Calendar" : "Google Calendar" })).toBeTruthy();
      expect(screen.getByText("Connected")).toBeTruthy();
    } else {
      expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect your calendar" })).toBeEnabled();
    }
  });

  it.each([true, false])("waits for auth or disables connection without an owner (auth loading=%s)", (authLoading) => {
    mocks.ownerId = null;
    mocks.authLoading = authLoading;
    render(<CalendarAgentPage />);
    if (authLoading) {
      expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
      expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
      expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull();
    } else {
      expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
      const connect = screen.getByRole("button", { name: "Connect your calendar" });
      expect(connect).toBeDisabled();
      fireEvent.click(connect);
    }
    expect(screen.queryByRole("heading", { name: "Connect Google Calendar" })).toBeNull();
    expect(mocks.startConnect).not.toHaveBeenCalled();
    expect(mocks.startNativeConnect).not.toHaveBeenCalled();
  });

  it("waits neutrally while an OAuth callback saves the connection", async () => {
    const view = render(<CalendarAgentPage connectionPending />);
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Finishing Calendar connection…");
    expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    view.rerender(<CalendarAgentPage />);
    await waitForConnectButton();
    expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
  });

  it("does not flash setup when returning to an already connected calendar", async () => {
    const connectedStatus = { configured: true, connected: true, status: "connected", access_level: "read", scope_csv: "" };
    mocks.status.mockResolvedValueOnce(connectedStatus);
    const firstVisit = render(<CalendarAgentPage />);
    await screen.findByText("Connected");
    firstVisit.unmount();
    let resolveStatus!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
    render(<CalendarAgentPage />);
    expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    await act(async () => resolveStatus(connectedStatus));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
  });

  it("offers retry for a failed connection check without showing setup", async () => {
    mocks.status.mockRejectedValueOnce(new Error("Request failed"));
    render(<CalendarAgentPage />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("Calendar connection couldn’t load. Try again.")).toBeTruthy();
    expect(screen.queryByText("Checking Calendar connection…")).toBeNull();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    let resolveStatus!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
    fireEvent.click(retry);
    expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    await act(async () => resolveStatus({ configured: true, connected: true, status: "connected", access_level: "read", scope_csv: "" }));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
  });

  it("retains Skip before connection and Finish after verified onboarding connection", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    mocks.startConnect.mockResolvedValue({ authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}` });
    const finish = vi.fn();
    const skip = vi.fn();
    render(<CalendarAgentPage journeyVariant="onboarding" onFinishSetup={finish} onSkipSetup={skip} />);
    const connect = await waitForConnectButton();
    expect(connect.getAttribute("data-voice-action-id")).toBe("setup.connect_calendar");
    fireEvent.click(screen.getByRole("button", { name: "Skip Calendar setup" }));
    expect(skip).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    fireEvent.click(connect);
    await waitForConsentWindow();
    const attempt = JSON.parse(mocks.popupAttempt);
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, source: mocks.popup,
      data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: attempt.attemptId, service: "calendar", outcome: "succeeded" },
    })));
    await screen.findByRole("button", { name: "Finish Calendar setup" });
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.getByRole("heading", { name: "Google Calendar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Calendar Agent with One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish Calendar setup" }));
    expect(finish).toHaveBeenCalledOnce();
    expect(skip).toHaveBeenCalledOnce();
  });

  it.each(["workspace", "onboarding"] as const)("returns to the illustration after disconnecting in %s", async (journeyVariant) => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", google_email: "owner@example.com", access_level: "read", scope_csv: "" });
    let settleDisconnect!: (value: unknown) => void;
    mocks.disconnect.mockImplementationOnce(() => new Promise((resolve) => { settleDisconnect = resolve; }));
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));
    render(<CalendarAgentPage journeyVariant={journeyVariant} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith("firebase-token", "calendar-user"));
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    await act(async () => settleDisconnect({ configured: true, connected: false, status: "disconnected", scope_csv: "" }));
    const connect = await waitForConnectButton();
    expect(screen.getByTestId("calendar-connect-hero")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("owner@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try Calendar Agent with One" })).toBeNull();
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.startConnect).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "calendar-user", accessLevel: "read",
    }));
  });

  it("keeps a verified popup success authoritative without a second status read", async () => {
    mocks.status.mockResolvedValue({
      configured: true, connected: false, status: "disconnected", scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`,
    });
    render(<CalendarAgentPage />);
    fireEvent.click(await waitForConnectButton());
    await waitForConsentWindow();
    const statusReadsBeforeCallback = mocks.status.mock.calls.length;
    const attempt = JSON.parse(mocks.popupAttempt) as { attemptId: string };
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin,
        source: mocks.popup,
        data: {
          schemaVersion: 1, type: "google_oauth_settlement",
          attemptId: attempt.attemptId, service: "calendar", outcome: "succeeded",
        },
      }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Connect your calendar" }),
      ).toBeNull(),
    );
    expect(mocks.status).toHaveBeenCalledTimes(statusReadsBeforeCallback);
    expect(screen.queryByRole("button", { name: "Allow One to find subscribed calendars" })).toBeNull();
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
  });

  it("never reads popup.closed, so a severed consent window is not an early failure", async () => {
    mocks.status.mockResolvedValue({
      configured: true, connected: false, status: "disconnected", scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`,
    });
    render(<CalendarAgentPage />);
    fireEvent.click(await waitForConnectButton());
    await waitForConsentWindow();
    // Google's opener policy makes a live consent window read as closed.
    Object.defineProperty(mocks.popup as object, "closed", {
      get: () => { throw new Error("popup.closed must not be read"); },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
  });

  it("suppresses abandoned popup recovery after the owner changes", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`,
    });

    const view = render(<CalendarAgentPage />);
    fireEvent.click(
      await waitForConnectButton(),
    );
    await waitForConsentWindow();
    mocks.ownerId = "other-owner";
    view.rerender(<CalendarAgentPage />);
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
  });

  it("records a Calendar popup timeout as a connection failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.status.mockResolvedValue({
        configured: true,
        connected: false,
        status: "disconnected",
        scope_csv: "",
      });
      mocks.startConnect.mockResolvedValue({
        authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`,
      });

      render(<CalendarAgentPage />);
      fireEvent.click(
        await waitForConnectButton(),
      );
      await waitForConsentWindow();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      await waitFor(() =>
        expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
          route_id: "one_calendar",
          action: "connected",
          result: "error",
        }),
      );
      expect(mocks.trackEvent).not.toHaveBeenCalledWith(
        "one_calendar_action",
        expect.objectContaining({ result: "expected_error" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a native Calendar consent dismissal as expected", async () => {
    mocks.native = true;
    mocks.status.mockResolvedValue({
      configured: true, connected: false, status: "disconnected", scope_csv: "",
    });
    mocks.startNativeConnect.mockResolvedValue({
      server_client_id: "native-client", access_level: "read", state: "state",
    });
    mocks.connectCalendar.mockRejectedValue(
      Object.assign(new Error("cancelled"), { code: "USER_CANCELLED" }),
    );
    render(<CalendarAgentPage />);
    fireEvent.click(await waitForConnectButton());
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "expected_error" },
    ));
    expect(mocks.completeNativeConnect).not.toHaveBeenCalled();
  });

  it("accepts a native additional Calendar account when the legacy default is disconnected", async () => {
    mocks.native = true;
    const existing = { account_id: "second", google_email: "second@example.com", connected: true, status: "connected", access_level: "manage", calendar_list_access: true };
    const added = { account_id: "third", google_email: "third@example.com", connected: true, status: "connected", access_level: "manage", calendar_list_access: true };
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "", accounts: [existing] });
    mocks.startNativeConnect.mockResolvedValue({ server_client_id: "native-client", access_level: "manage", include_calendar_list: true, state: "state" });
    mocks.connectCalendar.mockResolvedValue({ serverAuthCode: "auth-code" });
    mocks.completeNativeConnect.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "", accounts: [existing, added] });
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Calendar account" }));
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
      route_id: "one_calendar", action: "connected", result: "success",
    }));
    expect(mocks.startNativeConnect).toHaveBeenCalledWith(expect.objectContaining({ additional: true }));
  });

  it("preserves the structured free-window selection in the existing chat handoff", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "manage", scope_csv: "calendar.events" });
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Select free window" }));
    expect(useOneConversationSession.getState().pendingHandoff).toMatchObject({
      reason: "user_requested", calendarSlot: { date: "2030-10-15", durationMinutes: 60, timeZone: "Europe/London", ownerId: "calendar-user", windowStart: "2030-10-15T10:00:00Z", windowEnd: "2030-10-15T12:00:00Z" },
    });
    expect(mocks.navigateToAgentChat).toHaveBeenCalledOnce();
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });

  it("opens chat instead of starting a native scheduling upgrade for read-only Calendar", async () => {
    mocks.native = true;
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });
    render(<CalendarAgentPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Try Calendar Agent with One" }),
    );

    expect(mocks.navigateToAgentChat).toHaveBeenCalledWith();
    expect(mocks.startNativeConnect).not.toHaveBeenCalled();
    expect(mocks.completeNativeConnect).not.toHaveBeenCalled();
  });

  it("suppresses a late native outcome after the owner changes", async () => {
    let resolveCompletion!: (value: {
      configured: boolean;
      connected: boolean;
      status: string;
      access_level: string;
      scope_csv: string;
    }) => void;
    mocks.native = true;
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startNativeConnect.mockResolvedValue({
      server_client_id: "native-client",
      access_level: "read",
      state: "state",
    });
    mocks.connectCalendar.mockResolvedValue({ serverAuthCode: "auth-code" });
    mocks.completeNativeConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
    );

    const view = render(<CalendarAgentPage />);
    fireEvent.click(
      await waitForConnectButton(),
    );
    await waitFor(() => expect(mocks.completeNativeConnect).toHaveBeenCalled());
    mocks.ownerId = "other-owner";
    view.rerender(<CalendarAgentPage />);
    await act(async () => {
      resolveCompletion({
        configured: true,
        connected: true,
        status: "connected",
        access_level: "read",
        scope_csv: "calendar.freebusy",
      });
    });

    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
  });
  it("hides an old owner's connected account before the new status resolves", async () => {
    mocks.status.mockResolvedValueOnce({ configured: true, connected: true, status: "connected", google_email: "old@example.com", access_level: "read", scope_csv: "read" });
    let finish!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<CalendarAgentPage />);
    await screen.findByText("old@example.com");
    mocks.ownerId = "new-owner";
    view.rerender(<CalendarAgentPage />);
    expect(screen.queryByText("old@example.com")).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
    expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull();
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    await act(async () => finish({ configured: true, connected: false, status: "disconnected", scope_csv: "" }));
    expect(screen.queryByText("old@example.com")).toBeNull();
  });

  it("keeps the new owner checking when an old owner's status request fails", async () => {
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const view = render(<CalendarAgentPage />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledOnce());
    mocks.ownerId = "new-owner";
    view.rerender(<CalendarAgentPage />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    await act(async () => rejectOld(new Error("Old request failed")));
    expect(screen.getByRole("status").textContent).toBe("Checking Calendar connection…");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    await act(async () => resolveNew({ configured: true, connected: true, status: "connected", access_level: "read", scope_csv: "" }));
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it.each(["resolve", "reject"] as const)("does not let a delayed status refresh %s replace a verified connection", async (settlement) => {
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    mocks.status.mockResolvedValueOnce({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    mocks.status.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    mocks.startConnect.mockResolvedValue({ authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`, expires_at: new Date(Date.now() + 300_000).toISOString() });
    const view = render(<CalendarAgentPage />);
    await waitForConnectButton();
    view.rerender(<CalendarAgentPage connectionPending />);
    view.rerender(<CalendarAgentPage />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    fireEvent.click(await waitForConnectButton());
    await waitForConsentWindow();
    const attempt = JSON.parse(mocks.popupAttempt);
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: mocks.popup, data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: attempt.attemptId, service: "calendar", outcome: "succeeded" } }));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Connect your calendar" })).toBeNull());
    view.rerender(<CalendarAgentPage connectionPending />);
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.getByRole("heading", { name: "Calendar", exact: true })).toBeTruthy();
    await act(async () => settlement === "resolve"
      ? finish({ configured: true, connected: false, status: "disconnected", scope_csv: "" })
      : fail(new Error("Stale request failed")));
    expect(screen.queryByTestId("calendar-connect-hero")).toBeNull();
    expect(screen.getByRole("heading", { name: "Calendar", exact: true })).toBeTruthy();
  });

});

afterEach(() => publishValidatedAuthSessionPrincipal(null));
