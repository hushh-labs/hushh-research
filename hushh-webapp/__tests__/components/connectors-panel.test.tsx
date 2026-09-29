import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "owner-a", getIdToken: vi.fn() },
  token: "synthetic-owner-token" as string | null,
  overview: vi.fn(),
  startOAuthConnect: vi.fn(),
  documents: vi.fn(),
  liveBackground: vi.fn(),
  setLiveBackground: vi.fn(),
  push: vi.fn(),
  calendarRefresh: vi.fn(),
  calendarDisconnect: vi.fn(),
  calendar: { connected: false, loaded: true, error: null as string | null, status: { status: "disconnected" } },
  financial: { data: null as { data: Record<string, unknown> } | null, loading: false, error: null as string | null },
  gmailStatus: { connected: false, compose_permission_granted: false } as Record<string, boolean>,
  connectGmail: vi.fn(),
  startNativeConnect: vi.fn(),
  completeNativeConnect: vi.fn(),
  calendarStartConnect: vi.fn(),
  calendarStatus: vi.fn(),
  calendarStartNativeConnect: vi.fn(),
  calendarCompleteNativeConnect: vi.fn(),
  connectCalendar: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, vaultKey: state.token ? "synthetic-key" : null }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ ...state.calendar, refresh: state.calendarRefresh }) }));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    disconnect: state.calendarDisconnect,
    startConnect: state.calendarStartConnect,
    status: state.calendarStatus,
    startNativeConnect: state.calendarStartNativeConnect,
    completeNativeConnect: state.calendarCompleteNativeConnect,
  },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ usePkmDomainResource: () => state.financial }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: state.gmailStatus,
    loadingStatus: false,
    statusError: false,
    disconnectGmail: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    overview: state.overview,
    startOAuthConnect: state.startOAuthConnect,
    documents: state.documents,
    liveBackground: state.liveBackground,
    setLiveBackground: state.setLiveBackground,
  },
}));
vi.mock("@/components/consent/trusted-document-rules", () => ({
  TrustedDocumentRules: () => null,
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    startNativeConnect: state.startNativeConnect,
    completeNativeConnect: state.completeNativeConnect,
    recordConsentFailure: vi.fn(),
  },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectGmail: state.connectGmail, connectCalendar: state.connectCalendar },
}));
vi.mock("@/components/icons", () => ({
  ArrowLeftIcon: () => null,
  ChevronRightIcon: () => null,
  SearchIcon: () => null,
  XIcon: () => null,
}));

import { Capacitor } from "@capacitor/core";
import { ConnectorsPanel } from "@/components/agent/connectors-panel";

const callbacks = {
  onBack: vi.fn(),
  onAvailableChange: vi.fn(),
  onExternalModalChange: vi.fn(),
  onPrepareRecovery: vi.fn(async () => "ready" as const),
  onClearRecovery: vi.fn(async () => undefined),
};
const catalogItem = {
  connectorId: "example_docs",
  displayName: "Example Docs",
  description: "Read selected files",
  authStyle: "oauth",
  status: "not_connected",
};
const overview = (connectors: typeof catalogItem[] = []) => ({
  connectors,
  features: { connections_panel_v2: true, google_drive_connection: true },
});
const panel = (open = true) => <ConnectorsPanel open={open} {...callbacks} />;

describe("supported connector catalog", () => {
  beforeEach(() => {
    state.user.uid = "owner-a";
    state.token = "synthetic-owner-token";
    state.overview.mockReset().mockResolvedValue(overview());
    state.startOAuthConnect.mockReset();
    state.documents.mockReset().mockResolvedValue([]);
    state.liveBackground.mockReset().mockResolvedValue(false);
    state.setLiveBackground.mockReset().mockResolvedValue(undefined);
    state.push.mockReset();
    state.calendarRefresh.mockReset();
    state.calendarDisconnect.mockReset().mockResolvedValue({ connected: false, status: "disconnected" });
    state.calendarStartConnect.mockReset().mockResolvedValue({
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
      redirect_uri: "http://localhost:3000/one/profile/google/oauth/return",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    state.calendarStatus.mockReset().mockResolvedValue({ configured: true, connected: false, status: "disconnected" });
    state.calendarStartNativeConnect.mockReset();
    state.calendarCompleteNativeConnect.mockReset();
    state.connectCalendar.mockReset();
    state.user.getIdToken.mockResolvedValue("synthetic-firebase-token");
    state.calendar = { connected: false, loaded: true, error: null, status: { status: "disconnected" } };
    state.financial = { data: null, loading: false, error: null };
    state.gmailStatus = { connected: false, compose_permission_granted: false };
    Object.values(callbacks).forEach((callback) => callback.mockClear());
  });
  afterEach(cleanup);

  it("shows real connections without roadmap placeholders", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    for (const label of ["Connectors", "Google Drive", "Gmail"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: "Connect Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plaid" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connected" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Available" })).toBeInTheDocument();
    expect(screen.queryByText(/Google Workspace MCP|Finance connection|Read access after connection/)).not.toBeInTheDocument();
    expect(screen.queryByText("Read selected files")).not.toBeInTheDocument();
    for (const label of ["Coming soon", "Notion", "HubSpot", "Shopify", "Circle"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("shows built-in Drive when the external registry is empty", async () => {
    render(panel());
    expect(await screen.findByText("Google Drive")).toBeInTheDocument();
  });

  it("opens connected Plaid details without redirecting to portfolio sources", async () => {
    state.financial.data = { data: { connections_v1: {
      "synthetic-item": { institution_name: "Synthetic Bank", status: "active", products: [] },
    } } };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Plaid" }));
    expect(screen.getByText("Synthetic Bank")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText(/remove its connected financial records/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.push).not.toHaveBeenCalled();
  });

  it("does not offer a dead Drive connection action when OAuth is unconfigured", async () => {
    state.overview.mockResolvedValue(overview());
    render(panel());
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Google Drive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    expect(screen.getByText("Drive sign-in is not configured here. Try again later.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Drive" })).toBeEnabled();
  });

  it("offers selected-file Drive connection without claiming live Drive access", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: {
        connections_panel_v2: true,
        google_drive_live: false,
        google_drive_picker: true,
      },
    });
    render(panel());
    expect(await screen.findByRole("button", { name: "Connect Google Drive" })).toBeEnabled();
    expect(screen.getByText("Selected files only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    expect(screen.getByRole("button", { name: "Connect Drive" })).toBeEnabled();
    expect(screen.getByText("You can choose files after connecting. One cannot search your entire Drive with this access.")).toBeInTheDocument();
    expect(screen.queryByText("Drive sign-in is not configured here. Try again later.")).not.toBeInTheDocument();
  });

  it("cancels a pending web Drive OAuth start and closes the blank popup", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
        google_drive_picker: true,
      },
    });
    const popupClosed = vi.fn();
    const popup = {
      closed: false,
      close: popupClosed,
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
      sessionStorage: window.sessionStorage,
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    let startSignal: AbortSignal | undefined;
    state.startOAuthConnect.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Google Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));

    expect(startSignal?.aborted).toBe(true);
    expect(popupClosed).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(await screen.findByText("Drive connection cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
  });

  it("omits unsupported catalog placeholders even when the registry returns them", async () => {
    state.overview.mockResolvedValue(overview([
      { ...catalogItem, connectorId: "notion", displayName: "Notion" },
      { ...catalogItem, connectorId: "hubspot", displayName: "HubSpot" },
      catalogItem,
    ]));
    const { container } = render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    expect(screen.queryByText("Notion")).not.toBeInTheDocument();
    expect(screen.queryByText("HubSpot")).not.toBeInTheDocument();
    for (const provider of ["gmail", "drive", "calendar", "plaid"]) {
      expect(container.querySelector(`img[src="/icons/connectors/${provider}.svg"]`)).not.toBeNull();
    }
  });

  it("does not describe a failed Drive status check as disconnected", async () => {
    state.overview.mockRejectedValue(new Error("synthetic unavailable"));
    render(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
    expect(await screen.findByText("Connection status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Drive connection is unavailable in this session. Try again later.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Drive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Drive" })).toBeEnabled();
  });

  it("opens the requested provider directly from the Settings catalog", async () => {
    render(
      <ConnectorsPanel
        open
        surface="settings"
        initialConnector="gmail"
        {...callbacks}
      />,
    );
    expect((await screen.findAllByRole("heading", { name: "Gmail" })).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Back to connectors" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close connectors" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Mail" })).toBeInTheDocument();
  });

  it("offers explicit Gmail draft permission only for a connected account without it", async () => {
    state.gmailStatus = { connected: true, compose_permission_granted: false };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.getByRole("button", { name: "Enable Gmail drafts" })).toBeInTheDocument();
    state.gmailStatus = { connected: true, compose_permission_granted: true };
    cleanup();
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.queryByRole("button", { name: "Enable Gmail drafts" })).not.toBeInTheDocument();
  });

  // The backend refuses a native grant that drops a scope the connection holds,
  // so a modify grant made on the web must ride along when drafts are enabled.
  it("carries existing Gmail send and modify grants into native draft consent", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    state.gmailStatus = { connected: true, compose_permission_granted: false, send_permission_granted: true, modify_permission_granted: true };
    state.startNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", purpose: "compose" });
    state.connectGmail.mockResolvedValue({ serverAuthCode: "one-time-code" });
    state.completeNativeConnect.mockResolvedValue(undefined);
    try {
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
      fireEvent.click(screen.getByRole("button", { name: "Enable Gmail drafts" }));
      await waitFor(() => expect(state.connectGmail).toHaveBeenCalledWith({
        serverClientId: "native-client", purpose: "compose", preserveSend: true, preserveModify: true,
      }));
    } finally {
      vi.mocked(Capacitor.isNativePlatform).mockRestore();
    }
  });

  it("shows a compact Gmail disconnect action and asks before changing access", async () => {
    state.gmailStatus = { connected: true, compose_permission_granted: true };
    render(panel());
    const connected = within(screen.getByRole("region", { name: "Connected" }));
    fireEvent.click(await connected.findByRole("button", { name: "Disconnect Gmail" }));
    expect(screen.getByText("Disconnect Mail? Drive stays connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("never duplicates the built-in Drive connection", async () => {
    state.overview.mockResolvedValue(overview([{ ...catalogItem, connectorId: "google_drive", displayName: "Duplicate Drive" }]));
    render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    expect(screen.getAllByText("Google Drive")).toHaveLength(1);
    expect(screen.queryByText("Duplicate Drive")).not.toBeInTheDocument();
  });

  it("uses Calendar and vault Plaid status without duplicate built-ins", async () => {
    state.calendar = { connected: true, loaded: true, error: null, status: { status: "connected" } };
    state.financial.data = { data: { connections_v1: { synthetic: { status: "active" } } } };
    state.overview.mockResolvedValue(overview([
      { ...catalogItem, connectorId: "calendar", displayName: "Duplicate Calendar" },
      { ...catalogItem, connectorId: "plaid", displayName: "Duplicate Plaid" },
    ]));
    render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    const connected = within(screen.getByRole("region", { name: "Connected" }));
    expect(connected.getByText("Calendar")).toBeInTheDocument();
    expect(connected.getByText("Plaid")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate Calendar")).not.toBeInTheDocument();
    expect(screen.queryByText("Duplicate Plaid")).not.toBeInTheDocument();
  });

  it("filters the real connector list and restores it when search is cleared", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search connectors" });
    fireEvent.change(search, { target: { value: "example" } });
    expect(screen.getByText("Example Docs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Google Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gmail" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Google Drive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gmail" })).toBeInTheDocument();
  });

  it("offers Calendar connection when disconnected and a reviewed disconnect when connected", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Connect Calendar" }));
    // Connecting stays inside the drawer: no route change, no drawer exit.
    expect(callbacks.onBack).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    vi.mocked(window.open).mockRestore();
    state.calendar = { connected: true, loaded: true, error: null, status: { status: "connected" } };
    view.rerender(panel());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Calendar" }));
    expect(screen.getByText("Disconnect Calendar from One? Other connections stay active.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(state.calendarDisconnect).toHaveBeenCalledExactlyOnceWith("synthetic-firebase-token", "owner-a"));
    await waitFor(() => expect(state.calendarRefresh).toHaveBeenCalledOnce());
  });

  it("does not claim an unchecked Calendar connection is manageable", async () => {
    state.calendar = { connected: false, loaded: true, error: "Status unavailable", status: { status: "disconnected" } };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.calendarRefresh).toHaveBeenCalledOnce();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("rejects a delayed catalog after same-owner token rotation", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    state.token = "rotated-synthetic-token";
    view.rerender(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(2));
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
    expect(state.overview).toHaveBeenLastCalledWith("rotated-synthetic-token");
  });

  it("rejects a prior panel session's response after close and reopen", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    view.rerender(panel(false));
    view.rerender(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(2));
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("discards an old owner's delayed catalog", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    state.user.uid = "owner-b";
    state.token = "other-synthetic-token";
    view.rerender(panel());
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("hides protected catalog immediately on vault lock", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    const view = render(panel());
    await screen.findByText("Example Docs");
    state.token = null;
    view.rerender(panel());
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
    expect(screen.getByText("Unlock your vault to manage connectors.")).toBeInTheDocument();
  });

  describe("Calendar connects in place", () => {
    const ATTEMPT_KEY = "one_google_oauth_popup_attempt_v1";
    const SETTLEMENT_KEY = "one_google_oauth_popup_settlement_v1";
    type FakeWindow = Window & { close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };
    const fakeWindow = () => {
      const store = new Map<string, string>();
      return {
        closed: false,
        close: vi.fn(),
        focus: vi.fn(),
        document: { title: "" },
        location: { replace: vi.fn() },
        sessionStorage: {
          setItem: (key: string, value: string) => void store.set(key, value),
          getItem: (key: string) => store.get(key) ?? null,
          removeItem: (key: string) => void store.delete(key),
        },
      } as unknown as FakeWindow;
    };
    const attemptOf = (target: Window) =>
      JSON.parse(target.sessionStorage.getItem(ATTEMPT_KEY) || "null") as { attemptId: string; service: string } | null;
    const settlement = (attemptId: string, outcome = "succeeded") => ({
      schemaVersion: 1,
      type: "google_oauth_settlement",
      attemptId,
      service: "calendar",
      outcome,
    });
    const post = (data: unknown, source: unknown, origin = window.location.origin) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
      });
    const openCalendar = async () => {
      render(<ConnectorsPanel open initialConnector={null} {...callbacks} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect Calendar" }));
    };
    afterEach(() => {
      vi.restoreAllMocks();
      window.localStorage.clear();
    });

    it("opens a sized popup synchronously and settles only the exact popup attempt", async () => {
      const popup = fakeWindow();
      const open = vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      // Opened inside the click, before any awaited work.
      expect(open).toHaveBeenCalledExactlyOnceWith(
        "about:blank",
        "hushh-google-oauth",
        expect.stringContaining("popup=yes"),
      );
      await waitFor(() =>
        expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(
          "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
        ),
      );
      expect(state.calendarStartConnect).toHaveBeenCalledExactlyOnceWith({
        idToken: "synthetic-firebase-token",
        userId: "owner-a",
        accessLevel: "read",
      });
      expect(await screen.findByText("Finish signing in with Google in the window that opened.")).toBeInTheDocument();
      const attempt = attemptOf(popup);
      expect(attempt?.service).toBe("calendar");
      // The attempt marker in the popup carries no OAuth state or credentials.
      expect(popup.sessionStorage.getItem(ATTEMPT_KEY)).not.toContain("synthetic=calendar");

      // Negative controls: none of these may settle the attempt.
      await post(settlement(attempt!.attemptId), popup, "https://attacker.invalid");
      await post(settlement(attempt!.attemptId), window);
      await post(settlement("another-valid-attempt"), popup);
      await post({ ...settlement(attempt!.attemptId), service: "gmail_send" }, popup);
      await post({ ...settlement(attempt!.attemptId), type: "drive_oauth_settlement" }, popup);
      expect(state.calendarStatus).not.toHaveBeenCalled();
      expect(popup.close).not.toHaveBeenCalled();

      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      await post(settlement(attempt!.attemptId), popup);
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(state.calendarStatus).toHaveBeenCalledOnce();
      expect(state.calendarRefresh).toHaveBeenCalledOnce();
      expect(popup.close).toHaveBeenCalled();
      // The drawer never left: no route change, no back navigation.
      expect(state.push).not.toHaveBeenCalled();
      expect(callbacks.onBack).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Calendar details" })).toBeInTheDocument();

      // A late duplicate after settlement is ignored.
      await post(settlement(attempt!.attemptId), popup);
      expect(state.calendarStatus).toHaveBeenCalledOnce();
    });

    it("reports server truth, not the settlement, when the callback claims success", async () => {
      const popup = fakeWindow();
      vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
      await post(settlement(attemptOf(popup)!.attemptId), popup);
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(screen.queryByText("Calendar connected.")).not.toBeInTheDocument();
    });

    it("falls back to a new tab and settles through the storage event when the opener is severed", async () => {
      const tab = fakeWindow();
      const open = vi.spyOn(window, "open").mockImplementation(
        (_url?: string | URL, _target?: string, features?: string) => (features ? null : tab),
      );
      await openCalendar();
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenLastCalledWith("about:blank", "_blank", undefined);
      await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
      const attempt = attemptOf(tab)!;
      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      // Google's opener policy can null window.opener; the callback's
      // same-origin storage write is then the only signal.
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", {
          key: SETTLEMENT_KEY,
          newValue: JSON.stringify({ ...settlement(attempt.attemptId), sentAt: Date.now() }),
          storageArea: window.localStorage,
        }));
      });
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(state.push).not.toHaveBeenCalled();
    });

    it("stays in place without navigating when both popup and tab are refused", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const before = window.location.href;
      await openCalendar();
      expect(open).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("Allow pop-ups for One, then try again. Your chat and draft stay here.")).toBeInTheDocument();
      expect(state.calendarStartConnect).not.toHaveBeenCalled();
      expect(state.push).not.toHaveBeenCalled();
      expect(window.location.href).toBe(before);
    });

    it("cancelling sign-in shows a quiet not-connected state and ignores the late callback", async () => {
      const popup = fakeWindow();
      vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
      const attempt = attemptOf(popup)!;
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(popup.close).toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
      await post(settlement(attempt.attemptId), popup);
      expect(state.calendarStatus).not.toHaveBeenCalled();
      expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
    });

    it("keeps Mail in place with the same guidance when popup and tab are refused", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const before = window.location.href;
      render(<ConnectorsPanel open initialConnector={null} {...callbacks} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
      expect(await screen.findByText("Allow pop-ups for One, then try again. Your chat and draft stay here.")).toBeInTheDocument();
      expect(open).toHaveBeenCalledTimes(2);
      expect(state.push).not.toHaveBeenCalled();
      expect(window.location.href).toBe(before);
    });

    it("uses the native Google sheet on device without opening a window", async () => {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      const open = vi.spyOn(window, "open");
      state.calendarStartNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", service: "calendar", access_level: "read", state: "signed-state" });
      state.connectCalendar.mockResolvedValue({ serverAuthCode: "synthetic-auth-code" });
      state.calendarCompleteNativeConnect.mockResolvedValue({ connected: true, status: "connected" });
      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      await openCalendar();
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(open).not.toHaveBeenCalled();
      expect(state.connectCalendar).toHaveBeenCalledExactlyOnceWith({ serverClientId: "native-client", accessLevel: "read" });
      expect(state.calendarCompleteNativeConnect).toHaveBeenCalledExactlyOnceWith({
        idToken: "synthetic-firebase-token",
        userId: "owner-a",
        accessLevel: "read",
        serverAuthCode: "synthetic-auth-code",
        state: "signed-state",
      });
      expect(state.push).not.toHaveBeenCalled();
    });

    it("treats a dismissed native sheet as quietly not connected", async () => {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      state.calendarStartNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", service: "calendar", access_level: "read", state: "signed-state" });
      state.connectCalendar.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "USER_CANCELLED" }));
      await openCalendar();
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(state.calendarCompleteNativeConnect).not.toHaveBeenCalled();
    });
  });

  describe("live Drive background preparation", () => {
    const liveDrive = (profile: "live" | "selected" = "live") => ({
      connectors: [
        {
          connectorId: "google_drive",
          displayName: "Google Drive",
          description: "Drive",
          authStyle: "oauth",
          profile,
          status: "connected",
          available: true,
        },
      ],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
        google_drive_live: true,
      },
    });
    const openDrive = async () => {
      render(panel());
      // The row moves from Available to Connected once the overview arrives;
      // click the connected row, not the detached pre-overview one.
      await screen.findByRole("button", { name: "Disconnect Google Drive" });
      fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    };

    it("lets a live Drive owner turn on preparing requests while away", async () => {
      state.overview.mockResolvedValue(liveDrive());
      await openDrive();
      const toggle = await screen.findByRole("switch", { name: "Background preparation" });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(screen.queryByRole("button", { name: "Retry Drive" })).not.toBeInTheDocument();
      expect(screen.getByText("Sharing and approval")).toBeInTheDocument();
      expect(screen.getByText(/Sharing a file needs your approval or a document trust rule/)).toBeInTheDocument();
      expect(state.liveBackground).toHaveBeenCalledWith("synthetic-owner-token");
      fireEvent.click(screen.getByText("Background preparation"));
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
      expect(state.setLiveBackground).toHaveBeenCalledExactlyOnceWith("synthetic-owner-token", true);
      expect(await screen.findByText("Background preparation enabled.")).toBeInTheDocument();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
      expect(state.setLiveBackground).toHaveBeenLastCalledWith("synthetic-owner-token", false);
    });

    it("keeps the toggle off and says so when the change fails", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.setLiveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      const toggle = await screen.findByRole("switch", { name: "Background preparation" });
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);
      expect(
        await screen.findByText(
          "Drive could not finish this action. Check the connection and try again.",
        ),
      ).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("disables the toggle when the current setting cannot be read", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.liveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      const toggle = await screen.findByRole("switch", { name: "Background preparation" });
      await waitFor(() => expect(state.liveBackground).toHaveBeenCalled());
      await act(async () => undefined);
      expect(toggle).toBeDisabled();
      fireEvent.click(toggle);
      expect(state.setLiveBackground).not.toHaveBeenCalled();
    });

    it("does not show a stale connected status after a failed refresh", async () => {
      state.overview.mockResolvedValue(liveDrive());
      const view = render(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
      const drive = await screen.findByRole("region", { name: "Google Drive" });
      await within(drive).findByText("Connected");
      state.overview.mockRejectedValue(new Error("synthetic unavailable"));
      state.token = "renewed-owner-token";
      view.rerender(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
      expect(await within(drive).findByText("Connection status unavailable")).toBeInTheDocument();
      expect(within(drive).queryByText("Connected")).not.toBeInTheDocument();
    });

    it("offers no background toggle for selected-file access", async () => {
      state.overview.mockResolvedValue(liveDrive("selected"));
      await openDrive();
      await waitFor(() => expect(state.overview).toHaveBeenCalled());
      expect(await screen.findByRole("button", { name: "Enable full Drive access" })).toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: "Background preparation" })).not.toBeInTheDocument();
      expect(state.liveBackground).not.toHaveBeenCalled();
    });
  });
});
