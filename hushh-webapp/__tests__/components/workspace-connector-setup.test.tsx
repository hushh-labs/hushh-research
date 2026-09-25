import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceConnectorSetupCard } from "@/components/agent/connector-read-receipt";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";

const gmailState = vi.hoisted(() => ({ connected: false, disconnect: vi.fn(async () => ({ connected: false })) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner", getIdToken: async () => "synthetic-id-token" } }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({
  status: gmailState.connected ? { connected: true, needs_reauth: false } : null,
  loadingStatus: false, refreshStatus: async () => null, disconnectGmail: gmailState.disconnect,
}) }));

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
});
