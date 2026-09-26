import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceConnectorSetupCard } from "@/components/agent/connector-read-receipt";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";
import { VaultContext } from "@/lib/vault/vault-context";

const gmailState = vi.hoisted(() => ({ connected: false, disconnect: vi.fn(async () => ({ connected: false })) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner", getIdToken: async () => "synthetic-id-token" } }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({
  status: gmailState.connected ? { connected: true, needs_reauth: false } : null,
  loadingStatus: false, refreshStatus: async () => null, disconnectGmail: gmailState.disconnect,
}) }));

const calendarState = vi.hoisted(() => ({ loaded: true, connected: false, reauth: false }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({
  status: calendarState.loaded ? { connected: calendarState.connected || calendarState.reauth, status: calendarState.reauth ? "needs_reauth" : calendarState.connected ? "connected" : "not_connected" } : null,
  connected: calendarState.connected && !calendarState.reauth, loading: false, error: null, loaded: calendarState.loaded, refresh: () => undefined,
}) }));
const driveOverview = vi.hoisted(() => vi.fn(async () => ({ connectors: [] as Array<{ connectorId: string; status: string }>, features: {} })));
vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: { overview: driveOverview } }));

describe("Workspace connector setup card", () => {
  it("offers Gmail disconnect only after current status, with app confirmation", async () => {
    gmailState.connected = true;
    gmailState.disconnect.mockClear();
    render(<WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider: "gmail", status: "manage_available" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    expect(gmailState.disconnect).not.toHaveBeenCalled();
    const confirmButton = screen.getAllByRole("button", { name: "Disconnect Gmail" }).at(-1)!;
    expect(confirmButton).toHaveTextContent("Disconnect");
    expect(confirmButton).toHaveClass("min-w-0", "w-full");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("min-w-0", "w-full");
    fireEvent.click(confirmButton);
    await waitFor(() => expect(gmailState.disconnect).toHaveBeenCalledOnce());
    gmailState.connected = false;
  });
  it.each<WorkspaceConnectorProvider>(["drive", "gmail", "calendar"])(
    "offers an explicit in-app %s connection action",
    (provider) => {
      const onOpenConnections = vi.fn();
      render(
        <WorkspaceConnectorSetupCard
          experience={{
            type: "one.workspace_connector_setup.v1",
            provider,
            status: "connect_required",
          }}
          onOpenConnections={onOpenConnections}
        />,
      );

      const label = provider === "drive" ? "Drive" : provider === "gmail" ? "Gmail" : "Calendar";
      fireEvent.click(screen.getByRole("button", { name: `Connect ${label}` }));
      expect(onOpenConnections).toHaveBeenCalledWith(provider, expect.any(HTMLButtonElement));
      expect(screen.getByText(/Connecting does not share information with anyone/)).toBeInTheDocument();
    },
  );

  it("opens the existing connector surface for a private connector", () => {
    const onOpenConnections = vi.fn();
    render(<WorkspaceConnectorSetupCard experience={{
      type: "one.workspace_connector_setup.v1", provider: "custom", status: "manage_available",
    }} onOpenConnections={onOpenConnections} />);
    fireEvent.click(screen.getByRole("button", { name: "Open connectors" }));
    expect(onOpenConnections).toHaveBeenCalledWith("custom", expect.any(HTMLButtonElement));
    expect(screen.queryByText(/Connecting does not share/)).not.toBeInTheDocument();
  });
  it("shows saved connector status without implying an unchecked tool is connected", () => {
    const onOpenConnections = vi.fn();
    render(<WorkspaceConnectorSetupCard experience={{
      type: "one.workspace_connector_setup.v1", provider: "custom", status: "manage_available",
      saved: [{ id: `custom_${"a".repeat(32)}`, name: "Synthetic app", status: "saved" }],
    }} onOpenConnections={onOpenConnections} />);
    expect(screen.getByText("Synthetic app")).toBeInTheDocument();
    expect(screen.getByText("Tools not checked")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it.each<[WorkspaceConnectorProvider, string]>([["calendar", "calendar"], ["drive", "drive"], ["gmail", "gmail"]])(
    "shows the official %s mark aligned with the title on the Activity surface",
    (provider, brand) => {
      render(<WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider, status: "connect_required" }} onOpenConnections={vi.fn()} />);
      const card = screen.getByTestId("workspace-connector-setup");
      const mark = card.querySelector(`img[data-connector-brand="${brand}"]`);
      expect(mark).toHaveAttribute("src", `/icons/connectors/${brand}.svg`);
      // Same inset tone and radius as the Activity section, full message width.
      expect(card).toHaveClass("w-full", "rounded-[16px]");
      expect(card.className).not.toMatch(/max-w-|border-border/);
    },
  );

  it("renders no invented mark for private connectors", () => {
    render(<WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider: "custom", status: "manage_available" }} />);
    expect(screen.getByTestId("workspace-connector-setup").querySelector("img")).toBeNull();
  });

  it("shows a restored Calendar prompt as connected once the owner has connected it", () => {
    calendarState.connected = true;
    const onOpenConnections = vi.fn();
    render(<WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider: "calendar", status: "connect_required" }} onOpenConnections={onOpenConnections} />);
    expect(screen.getByRole("status")).toHaveTextContent("Calendar · Connected");
    expect(screen.queryByText("Connect Calendar to continue")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage Calendar" }));
    expect(onOpenConnections).toHaveBeenCalledWith("calendar", expect.any(HTMLButtonElement));
    calendarState.connected = false;
  });

  it("asks to reconnect a Calendar grant that needs reauthorization", () => {
    calendarState.reauth = true;
    render(<WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider: "calendar", status: "connect_required" }} onOpenConnections={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnect Calendar to continue");
    expect(screen.getByRole("button", { name: "Reconnect Calendar" })).toBeEnabled();
    calendarState.reauth = false;
  });

  it("shows a restored Drive prompt as connected from the owner's current connector overview", async () => {
    driveOverview.mockResolvedValueOnce({ connectors: [{ connectorId: "google_drive", status: "connected" }], features: {} });
    render(
      <VaultContext.Provider value={{ vaultOwnerToken: "synthetic-vault-owner-token" } as never}>
        <WorkspaceConnectorSetupCard experience={{ type: "one.workspace_connector_setup.v1", provider: "drive", status: "connect_required" }} onOpenConnections={vi.fn()} />
      </VaultContext.Provider>,
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Drive · Connected"));
    expect(driveOverview).toHaveBeenCalledWith("synthetic-vault-owner-token");
    expect(screen.getByRole("button", { name: "Manage Drive" })).toBeInTheDocument();
  });
});
