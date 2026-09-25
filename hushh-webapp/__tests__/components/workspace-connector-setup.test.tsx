import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceConnectorSetupCard } from "@/components/agent/connector-read-receipt";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";

describe("Workspace connector setup card", () => {
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
});
