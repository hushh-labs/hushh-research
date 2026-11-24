import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentConnectorContinuationContext,
  ConnectorReadReceipt,
  TurnLocationPermissionCard,
  WorkspaceConnectorSetupCard,
} from "@/components/agent/connector-read-receipt";
import {
  parseAgentActivityExperience,
  parseAgentToolResultExperience,
} from "@/lib/agent/agui-structured-experiences";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";
import { VaultContext } from "@/lib/vault/vault-context";

const locationBusMock = vi.hoisted(() => {
  const listeners = new Set<(state: Record<string, unknown>) => void>();
  let current: Record<string, unknown> = {
    status: "idle",
    permission: "prompt",
    snapshot: null,
    error: null,
    snapshotOrigin: null,
  };
  return {
    getState: vi.fn(() => current),
    setState(next: Record<string, unknown>) {
      current = { ...current, ...next };
      for (const listener of listeners) listener(current);
    },
    subscribe: vi.fn((listener: (state: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    syncPermission: vi.fn(async () => current.permission),
    request: vi.fn(async () => {
      const fix = {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracyM: 12,
        capturedAt: new Date().toISOString(),
        sourcePlatform: "web" as const,
      };
      current = {
        status: "ready",
        permission: "granted",
        snapshot: fix,
        error: null,
        snapshotOrigin: "fresh",
      };
      for (const listener of listeners) listener(current);
      return fix;
    }),
  };
});
vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: locationBusMock,
}));

const plaidState = vi.hoisted(() => ({
  financialData: null as Record<string, unknown> | null,
  connect: vi.fn(async () => ({ status: "connected" as const, institutionName: "First Platypus Bank" })),
  refresh: vi.fn(async () => ({ refreshed: 1, failed: 0, needsRelink: [] as string[] })),
  wikiSync: vi.fn(async () => true),
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  usePkmDomainResource: () => ({
    data: plaidState.financialData ? { data: plaidState.financialData } : null,
    loading: false,
    error: null,
    refresh: async () => ({ data: plaidState.financialData }),
  }),
}));
vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  connectVaultPlaid: plaidState.connect,
  refreshVaultConnections: plaidState.refresh,
  vaultConnections: (financial: Record<string, unknown> | null | undefined) =>
    ((financial?.connections_v1 as Record<string, unknown> | undefined) ?? {}),
}));
vi.mock("@/lib/kai/plaid-vault/wiki-posture-sync", () => ({
  syncPlaidPostureToPersonalWikiBestEffort: plaidState.wikiSync,
}));

const gmailState = vi.hoisted(() => ({ connected: false, disconnect: vi.fn(async () => ({ connected: false })) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner", getIdToken: async () => "synthetic-id-token" }, userId: "synthetic-owner" }) }));
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
  it("keeps the provider mark on a read's connection-required prompt", () => {
    const onOpenConnections = vi.fn();
    const { container } = render(<ConnectorReadReceipt experience={{
      type: "one.connector_read.v1", connector: "drive", status: "connect_required",
      sourceRefs: [], metadataOnly: true, truncated: false,
    }} onOpenConnections={onOpenConnections} />);
    expect(container.querySelector('img[data-connector-brand="drive"]')).toHaveAttribute("src", "/icons/connectors/drive.svg");
    fireEvent.click(screen.getByRole("button", { name: "Connect Drive" }));
    expect(onOpenConnections).toHaveBeenCalledWith("drive", expect.any(HTMLButtonElement));
  });
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
    fireEvent.click(screen.getByRole("button", { name: "Continue in chat" }));
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

  it("renders inline Plaid and Stripe cards with official SVGs and completes inline Plaid connect -> Wiki -> Chat continuation", async () => {
    const continueAfterConnectorSync = vi.fn();
    plaidState.financialData = null;
    plaidState.connect.mockClear();
    plaidState.wikiSync.mockClear();

    const { container } = render(
      <VaultContext.Provider
        value={{ vaultKey: "synthetic-vault-key", vaultOwnerToken: "synthetic-vault-owner-token" } as never}
      >
        <AgentConnectorContinuationContext.Provider value={{ continueAfterConnectorSync }}>
          <WorkspaceConnectorSetupCard
            experience={{ type: "one.workspace_connector_setup.v1", provider: "plaid", status: "connect_required" }}
          />
        </AgentConnectorContinuationContext.Provider>
      </VaultContext.Provider>,
    );

    expect(container.querySelector('img[data-connector-brand="plaid"]')).toHaveAttribute(
      "src",
      "/icons/connectors/plaid.svg",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect bank" }));
    await waitFor(() => expect(plaidState.connect).toHaveBeenCalledOnce());
    await waitFor(() => expect(plaidState.wikiSync).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(continueAfterConnectorSync).toHaveBeenCalledWith(
        expect.stringContaining("First Platypus Bank"),
      ),
    );

    const stripeRender = render(
      <WorkspaceConnectorSetupCard
        experience={{ type: "one.workspace_connector_setup.v1", provider: "stripe", status: "connect_required" }}
      />,
    );
    expect(stripeRender.container.querySelector('img[data-connector-brand="stripe"]')).toHaveAttribute(
      "src",
      "/icons/connectors/stripe.svg",
    );
    expect(screen.getByRole("button", { name: "Set up Stripe" })).toBeInTheDocument();
  });

  it("maps get_my_location permission results to an inline toggle card and auto-continues the chat turn once allowed", async () => {
    locationBusMock.setState({
      status: "idle",
      permission: "prompt",
      snapshot: null,
      error: null,
      snapshotOrigin: null,
    });
    locationBusMock.request.mockClear();

    const parsed = parseAgentToolResultExperience("get_my_location", {
      status: "needs_location_permission",
      permission: "not_granted",
      message: "Allow location access on the card below so I can check that for where you are right now.",
    });
    expect(parsed).toEqual({
      type: "one.turn_location_permission.v1",
      permission: "not_granted",
    });
    expect(
      parseAgentActivityExperience("one.turn_location_permission.v1", {
        permission: "denied",
      }),
    ).toEqual({
      type: "one.turn_location_permission.v1",
      permission: "denied",
    });

    const continueAfterConnectorSync = vi.fn();
    render(
      <AgentConnectorContinuationContext.Provider value={{ continueAfterConnectorSync }}>
        <TurnLocationPermissionCard
          experience={{
            type: "one.turn_location_permission.v1",
            permission: "not_granted",
          }}
        />
      </AgentConnectorContinuationContext.Provider>,
    );

    expect(screen.getByTestId("turn-location-permission-card")).toHaveTextContent(
      "Allow device location",
    );
    const toggle = screen.getByTestId("turn-location-permission-switch");
    fireEvent.click(toggle);

    await waitFor(() => expect(locationBusMock.request).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(continueAfterConnectorSync).toHaveBeenCalledWith(
        expect.stringContaining("Location access is now allowed"),
      ),
    );
    expect(screen.getByTestId("turn-location-permission-card")).toHaveTextContent(
      "Device location · Allowed",
    );
  });
});
