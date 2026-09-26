import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorsPanel } from "@/components/agent/connectors-panel";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "test-owner", getIdToken: async () => "test-id-token" } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "test-vault-token" }),
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: false },
    loadingStatus: false,
    statusError: null,
    refreshStatus: vi.fn(),
    disconnectGmail: vi.fn(),
  }),
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: service,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: vi.fn() },
}));

const listed = [
  {
    connectorId: "notion",
    displayName: "Notion",
    description: "Notes and projects",
    authStyle: "api_key",
    status: "connected",
    accountLabel: "Workspace A",
  },
  {
    connectorId: "slack",
    displayName: "Slack",
    description: "Messages and channels",
    authStyle: "oauth",
    status: "not_connected",
  },
];

beforeEach(() => {
  service.list.mockReset().mockResolvedValue(listed);
  service.disconnect.mockReset().mockResolvedValue(undefined);
});

describe("Connectors manager", () => {
  it("filters connected, available, and upcoming services from one search field", async () => {
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Notion")).toBeTruthy();
    expect(screen.getByText("Google Workspace")).toBeTruthy();
    expect(screen.getByText("Slack")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), {
      target: { value: "Notion" },
    });

    expect(screen.getByText("Notion")).toBeTruthy();
    expect(screen.queryByText("Google Workspace")).toBeNull();
    expect(screen.queryByText("Slack")).toBeNull();
  });

  it("keeps provider marks distinct while preserving the generic fallback", async () => {
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Notion")).toBeTruthy();

    const notion = document.querySelector('[data-connector-mark="notion"] svg');
    const slack = document.querySelector('[data-connector-mark="slack"] svg');
    const microsoft = document.querySelector(
      '[data-connector-mark="microsoft-graph"] svg',
    );
    expect(notion).toBeTruthy();
    expect(slack).toBeTruthy();
    expect(microsoft).toBeTruthy();
    expect(notion?.innerHTML).not.toBe(slack?.innerHTML);
    expect(microsoft?.innerHTML).not.toBe(slack?.innerHTML);
    expect(document.querySelector('[data-connector-mark="google-workspace"]')).toBeTruthy();
  });

  it("requires a clear confirmation before disconnecting a service", async () => {
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Notion" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(within(confirmation).getByText("Disconnect Notion?")).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep connected" }));
    expect(service.disconnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Notion" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );
    await waitFor(() => {
      expect(service.disconnect).toHaveBeenCalledWith({
        vaultOwnerToken: "test-vault-token",
        connectorId: "notion",
      });
    });
  });
});
