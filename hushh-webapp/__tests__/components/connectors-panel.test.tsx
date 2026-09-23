import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "owner-a", getIdToken: vi.fn() },
  token: "synthetic-owner-token" as string | null,
  list: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/components/agent/drive-connector-card", () => ({
  DriveConnectorCard: () => <div>Google Drive</div>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: false },
    disconnectGmail: vi.fn(),
  }),
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { list: state.list },
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {},
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/components/icons", () => ({ Unplug: () => null }));
vi.mock("@/components/ui/sheet", () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    Sheet: Part,
    SheetContent: Part,
    SheetDescription: Part,
    SheetHeader: Part,
    SheetTitle: Part,
  };
});
vi.mock("@/components/ui/dialog", () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
      open ? <div>{children}</div> : null,
    DialogContent: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogTitle: Part,
  };
});

import { ConnectorsPanel } from "@/components/agent/connectors-panel";

const drive = {
  connectorId: "example_docs",
  displayName: "Example Docs",
  description: "Read selected files",
  authStyle: "oauth",
  status: "not_connected",
};

describe("supported connector catalog", () => {
  beforeEach(() => {
    state.user.uid = "owner-a";
    state.token = "synthetic-owner-token";
    state.list.mockReset().mockResolvedValue([]);
    state.push.mockReset();
  });
  afterEach(cleanup);

  it("shows supported connections and registered tools without roadmap placeholders", async () => {
    state.list.mockResolvedValue([drive]);
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(
      screen.getByText(/Drive uses MCP; other services use/),
    ).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Calendar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Plaid" }),
    ).toBeInTheDocument();
    for (const label of [
      "Coming soon",
      "Notion",
      "HubSpot",
      "Shopify",
      "Circle",
      "Gmail and Calendar",
    ]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("shows the built-in Drive connection even when the external registry is empty", async () => {
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    await screen.findByText("Gmail");
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
  });

  it("does not offer a second generic OAuth flow for reserved Google Drive", async () => {
    state.list.mockResolvedValue([
      { ...drive, connectorId: "google_drive", displayName: "Duplicate Drive" },
    ]);
    render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    await screen.findByText("Gmail");
    expect(screen.getAllByText("Google Drive")).toHaveLength(1);
    expect(screen.queryByText("Duplicate Drive")).not.toBeInTheDocument();
  });

  it.each([
    ["Calendar", "/one/calendar"],
    ["Plaid", "/one/kai/portfolio/sources"],
  ])(
    "opens the existing %s management surface and closes the panel",
    async (name, route) => {
      const onOpenChange = vi.fn();
      render(<ConnectorsPanel open onOpenChange={onOpenChange} />);
      fireEvent.click(
        await screen.findByRole("button", { name: `Manage ${name}` }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(state.push).toHaveBeenCalledExactlyOnceWith(route);
    },
  );

  it("rejects a delayed catalog after same-owner token rotation", async () => {
    let finish!: (value: (typeof drive)[]) => void;
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const view = render(<ConnectorsPanel open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    state.token = "rotated-synthetic-token";
    view.rerender(<ConnectorsPanel open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    await act(async () => finish([drive]));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
    expect(state.list).toHaveBeenLastCalledWith("rotated-synthetic-token");
  });

  it("rejects the prior panel session's response after close and reopen", async () => {
    let finish!: (value: (typeof drive)[]) => void;
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const view = render(<ConnectorsPanel open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    view.rerender(<ConnectorsPanel open={false} onOpenChange={onOpenChange} />);
    view.rerender(<ConnectorsPanel open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    await act(async () => finish([drive]));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("discards an old owner's delayed catalog after owner changes", async () => {
    let finish!: (value: (typeof drive)[]) => void;
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    state.user.uid = "owner-b";
    state.token = "other-synthetic-token";
    view.rerender(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    await act(async () => finish([drive]));
    await screen.findByText("Gmail");
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("hides protected catalog immediately on vault lock", async () => {
    state.list.mockResolvedValue([drive]);
    const view = render(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    await screen.findByText("Example Docs");
    state.token = null;
    view.rerender(<ConnectorsPanel open onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });
});
