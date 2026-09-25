import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "owner-a", getIdToken: vi.fn() },
  token: "synthetic-owner-token" as string | null,
  overview: vi.fn(),
  documents: vi.fn(),
  liveBackground: vi.fn(),
  setLiveBackground: vi.fn(),
  push: vi.fn(),
  calendar: { connected: false, loaded: true, error: null as string | null, status: { status: "disconnected" } },
  financial: { data: null as { data: Record<string, unknown> } | null, loading: false, error: null as string | null },
  gmailStatus: { connected: false, compose_permission_granted: false },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, vaultKey: state.token ? "synthetic-key" : null }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => state.calendar }));
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
    documents: state.documents,
    liveBackground: state.liveBackground,
    setLiveBackground: state.setLiveBackground,
  },
}));
vi.mock("@/components/consent/trusted-document-rules", () => ({
  TrustedDocumentRules: () => null,
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({ GmailReceiptsService: {} }));
vi.mock("@/components/icons", () => ({
  ArrowLeftIcon: () => null,
  ChevronRightIcon: () => null,
  SearchIcon: () => null,
  XIcon: () => null,
}));

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
    state.documents.mockReset().mockResolvedValue([]);
    state.liveBackground.mockReset().mockResolvedValue(false);
    state.setLiveBackground.mockReset().mockResolvedValue(undefined);
    state.push.mockReset();
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
    expect(screen.getByRole("button", { name: "Manage Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage Plaid" })).toBeInTheDocument();
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

  it("does not offer a dead Drive connection action when backend admission is off", async () => {
    state.overview.mockResolvedValue(overview());
    render(panel());
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Google Drive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    expect(screen.getByText("Drive sign-in is not enabled for this account in this environment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Drive" })).toBeEnabled();
  });

  it("offers selected-file Drive connection without claiming live Drive access", async () => {
    state.overview.mockResolvedValue({
      connectors: [],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
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
    expect(screen.queryByText("Drive sign-in is not enabled for this account in this environment.")).not.toBeInTheDocument();
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

  it.each([
    ["Calendar", "/one/calendar"],
    ["Plaid", "/one/kai/portfolio/sources"],
  ])("opens %s in this app", async (name, route) => {
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: `Manage ${name}` }));
    expect(callbacks.onBack).toHaveBeenCalledOnce();
    expect(state.push).toHaveBeenCalledExactlyOnceWith(route);
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
      await screen.findByText("Search your Drive");
      fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    };

    it("lets a live Drive owner turn on preparing requests while away", async () => {
      state.overview.mockResolvedValue(liveDrive());
      await openDrive();
      const toggle = await screen.findByRole("button", { name: "Prepare requests while away" });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(state.liveBackground).toHaveBeenCalledWith("synthetic-owner-token");
      fireEvent.click(toggle);
      expect(
        await screen.findByRole("button", { name: "Stop background preparation" }),
      ).toBeInTheDocument();
      expect(state.setLiveBackground).toHaveBeenCalledExactlyOnceWith("synthetic-owner-token", true);
      expect(await screen.findByText("Background preparation enabled.")).toBeInTheDocument();
    });

    it("keeps the toggle off and says so when the change fails", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.setLiveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      const toggle = await screen.findByRole("button", { name: "Prepare requests while away" });
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);
      expect(
        await screen.findByText(
          "Drive could not finish this action. Check the connection and try again.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prepare requests while away" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop background preparation" })).not.toBeInTheDocument();
    });

    it("disables the toggle when the current setting cannot be read", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.liveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      const toggle = await screen.findByRole("button", { name: "Prepare requests while away" });
      await waitFor(() => expect(state.liveBackground).toHaveBeenCalled());
      await act(async () => undefined);
      expect(toggle).toBeDisabled();
      fireEvent.click(toggle);
      expect(state.setLiveBackground).not.toHaveBeenCalled();
    });

    it("offers no background toggle for selected-file access", async () => {
      state.overview.mockResolvedValue(liveDrive("selected"));
      await openDrive();
      await waitFor(() => expect(state.overview).toHaveBeenCalled());
      expect(await screen.findByText("Retry Drive")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Prepare requests while away" })).not.toBeInTheDocument();
      expect(state.liveBackground).not.toHaveBeenCalled();
    });
  });
});
