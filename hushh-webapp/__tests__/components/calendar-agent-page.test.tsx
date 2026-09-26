import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  startConnect: vi.fn(),
  startNativeConnect: vi.fn(),
  completeNativeConnect: vi.fn(),
  disconnect: vi.fn(),
  getIdToken: vi.fn(),
  navigateToAgentChat: vi.fn(),
  trackEvent: vi.fn(),
  connectCalendar: vi.fn(),
  ownerId: "calendar-user" as string | null,
  native: false,
  popup: null as Window | null,
  popupAttempt: "",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectCalendar: mocks.connectCalendar },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.trackEvent }));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: mocks.navigateToAgentChat,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mocks.ownerId
      ? { uid: mocks.ownerId, getIdToken: mocks.getIdToken }
      : null,
    loading: false,
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";

describe("CalendarAgentPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.native = false;
    mocks.ownerId = "calendar-user";
    mocks.popupAttempt = "";
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

  it("requests read-only access before an owner enables Calendar scheduling", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));

    render(<CalendarAgentPage />);

    const connect = await screen.findByRole("button", {
      name: "Connect",
    });
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

  it("keeps a healthy Calendar connection focused on chat and disconnect", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "manage",
      scope_csv: "calendar.events calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText("Connected");
    const chat = screen.getByRole("button", {
      name: "Try Calendar Agent with One",
    });
    expect(chat).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Reconnect Calendar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable scheduling" })).toBeNull();

    fireEvent.click(chat);
    expect(mocks.navigateToAgentChat).toHaveBeenCalledWith();
  });

  it("offers an explicit scheduling upgrade for a connected read-only Calendar", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText(/View events and availability/);
    expect(screen.queryByRole("button", { name: /Reconnect/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Enable scheduling" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try Calendar Agent with One" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enable scheduling" }));
    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        accessLevel: "manage",
      }),
    );
  });

  it("keeps the Calendar connection surface focused on connection", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });

    render(<CalendarAgentPage journeyVariant="onboarding" />);

    expect(await screen.findByText("Connect")).toBeTruthy();
    expect(screen.queryByText("Try asking One")).toBeNull();
    expect(screen.queryByText(/Summarize my calendar for this week/)).toBeNull();
  });

  it("introduces Calendar with three guidance rows and preserves the skip action", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    const skip = vi.fn();
    const { container } = render(<CalendarAgentPage journeyVariant="onboarding" onSkipSetup={skip} onFinishSetup={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Google Calendar" })).toBeTruthy();
    expect(screen.getByText("Plan your day with One.")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual([
      "See what’s ahead", "You’re in control", "Review before confirming",
    ]);
    expect(screen.getByText("Private by default. Disconnect anytime.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Keep an eye on things|Muse|Meta/);
    expect(container.querySelector('[data-calendar-connect-onboarding]')?.className).toContain('max-w-md');
    expect(container.querySelector('[data-calendar-connect-onboarding]')?.className).toContain('dark:bg-muted');
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect.getAttribute("data-voice-control-id")).toBe("open_calendar_connector");
    expect(connect.getAttribute("data-voice-action-id")).toBe("setup.connect_calendar");
    const notNow = screen.getByRole("button", { name: "Not now" });
    expect(notNow.getAttribute("data-voice-control-id")).toBe("skip_calendar_setup");
    expect(notNow.getAttribute("data-voice-action-id")).toBe("setup.skip_calendar");
    fireEvent.click(notNow);
    expect(skip).toHaveBeenCalledOnce();
  });

  it("keeps deferral onboarding-only and exposes authorization busy state", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "disconnected", scope_csv: "" });
    mocks.startConnect.mockReturnValue(new Promise(() => {}));
    render(<CalendarAgentPage />);
    const connect = await screen.findByRole("button", { name: "Connect" });
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    fireEvent.click(connect);
    await waitFor(() => expect(connect.getAttribute("aria-busy")).toBe("true"));
    expect((connect as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves reconnect and verified finish controls", async () => {
    mocks.status.mockResolvedValue({ configured: true, connected: false, status: "needs_reauth", scope_csv: "" });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));
    const finish = vi.fn();
    const view = render(<CalendarAgentPage journeyVariant="onboarding" onFinishSetup={finish} onSkipSetup={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Calendar" }));
    await waitFor(() => expect(mocks.startConnect).toHaveBeenCalledWith(expect.objectContaining({ accessLevel: "read" })));
    view.unmount();
    mocks.status.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read", scope_csv: "" });
    render(<CalendarAgentPage journeyVariant="onboarding" onFinishSetup={finish} onSkipSetup={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Finish Calendar setup" });
    expect(button.getAttribute("data-voice-control-id")).toBe("finish_calendar_setup");
    fireEvent.click(button);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("preserves pending credential persistence without offering connection", () => {
    render(<CalendarAgentPage connectionPending />);
    expect(screen.getByText("Finishing Calendar connection…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("retains status-checking feedback until the existing connection is resolved", async () => {
    let resolveStatus!: (value: unknown) => void;
    mocks.status.mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    render(<CalendarAgentPage />);
    expect(screen.getByText("Checking Calendar connection…")).toBeTruthy();
    expect(screen.queryByText("Plan your day with One.")).toBeNull();
    await act(async () => resolveStatus({ configured: true, connected: true, status: "connected", access_level: "read", scope_csv: "" }));
    expect(await screen.findByRole("button", { name: "Enable scheduling" })).toBeTruthy();
  });

  it("keeps a verified popup success authoritative without a second status read", async () => {
    mocks.status.mockResolvedValue({
      configured: true, connected: false, status: "disconnected", scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: "https://accounts.google.test",
    });
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.popupAttempt).not.toBe(""));
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
        screen.queryByRole("button", { name: "Connect" }),
      ).toBeNull(),
    );
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
  });

  it("does not treat an abandoned scheduling upgrade as connected", async () => {
    let popupWatcher: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 500 && typeof handler === "function") popupWatcher = handler;
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: "https://accounts.google.test",
    });

    render(<CalendarAgentPage />);
    await waitFor(() => expect(popupWatcher).not.toBeNull());
    fireEvent.click(
      await screen.findByRole("button", { name: "Enable scheduling" }),
    );
    await waitFor(() => expect(mocks.popupAttempt).not.toBe(""));
    Object.assign(mocks.popup as object, { closed: true });
    await act(async () => {
      popupWatcher?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
        route_id: "one_calendar",
        action: "connected",
        result: "expected_error",
      }),
    );
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ result: "success" }),
    );
  });

  it("suppresses abandoned popup recovery after the owner changes", async () => {
    let popupWatcher: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 500 && typeof handler === "function") {
        popupWatcher = handler;
      }
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: "https://accounts.google.test",
    });

    const view = render(<CalendarAgentPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect" }),
    );
    await waitFor(() => expect(mocks.popupAttempt).not.toBe(""));
    mocks.ownerId = "other-owner";
    view.rerender(<CalendarAgentPage />);
    Object.assign(mocks.popup as object, { closed: true });
    await act(async () => {
      popupWatcher?.();
      await Promise.resolve();
    });

    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ action: "connected" }),
    );
  });

  it("records a Calendar popup timeout as a connection failure", async () => {
    let popupWatcher: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 500 && typeof handler === "function") popupWatcher = handler;
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: "https://accounts.google.test",
    });

    render(<CalendarAgentPage />);
    await waitFor(() => expect(popupWatcher).not.toBeNull());
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect" }),
    );
    await waitFor(() => expect(mocks.popupAttempt).not.toBe(""));
    now.mockReturnValue(121_001);
    await act(async () => {
      popupWatcher?.();
      await Promise.resolve();
      await Promise.resolve();
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
  });

  it("keeps a verified scheduling upgrade at manage access", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: "https://accounts.google.test",
    });

    render(<CalendarAgentPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Enable scheduling" }),
    );
    await waitFor(() => expect(mocks.popupAttempt).not.toBe(""));
    const attempt = JSON.parse(mocks.popupAttempt) as { attemptId: string };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: mocks.popup,
          data: {
            schemaVersion: 1,
            type: "google_oauth_settlement",
            attemptId: attempt.attemptId,
            service: "calendar",
            outcome: "succeeded",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Enable scheduling" }),
      ).toBeNull(),
    );
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
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "expected_error" },
    ));
    expect(mocks.completeNativeConnect).not.toHaveBeenCalled();
  });

  it("rejects a native read-only result for a manage upgrade", async () => {
    mocks.native = true;
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });
    mocks.startNativeConnect.mockResolvedValue({
      server_client_id: "native-client",
      access_level: "manage",
      state: "state",
    });
    mocks.connectCalendar.mockResolvedValue({ serverAuthCode: "auth-code" });
    mocks.completeNativeConnect.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });

    render(<CalendarAgentPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Enable scheduling" }),
    );

    await waitFor(() =>
      expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
        route_id: "one_calendar",
        action: "connected",
        result: "error",
      }),
    );
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action",
      expect.objectContaining({ result: "success" }),
    );
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
      await screen.findByRole("button", { name: "Connect" }),
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
});
