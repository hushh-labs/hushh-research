import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletSharing } from "@/components/wallet/wallet-sharing";
import { loadWalletSharing } from "@/lib/services/wallet-sharing-service";
const mocks = vi.hoisted(() => ({ push: vi.fn(), approve: vi.fn(), deny: vi.fn(), revoke: vi.fn(), vaultKey: "test-key" as string | null, user: { uid: "owner", getIdToken: vi.fn().mockResolvedValue("test") } }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.vaultKey }) }));
vi.mock("@/lib/consent/use-consent-actions", () => ({ useConsentActions: () => ({ handleApprove: mocks.approve, handleDeny: mocks.deny, handleRevoke: mocks.revoke }) }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/services/wallet-sharing-service", async (original) => ({ ...await original<object>(), loadWalletSharing: vi.fn() }));
describe("Wallet Sharing", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.vaultKey = "test-key"; mocks.approve.mockResolvedValue(undefined); mocks.deny.mockResolvedValue(undefined); mocks.revoke.mockResolvedValue(undefined); });
  it("shows real empty states", async () => {
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [], grants: [] });
    render(<WalletSharing />);
    await screen.findByText("No Wallet requests");
    expect(screen.getByText("No active Wallet sharing")).toBeVisible();
  });
  it("reviews full details inside Wallet and approves only after an explicit click", async () => {
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [{ id: "request-1", request_id: "request-1", scope: "attr.wallet.secrets.*", kind: "incoming_request", status: "pending", action: "request", counterpart_type: "person", counterpart_label: "Test requester" }], grants: [] });
    render(<WalletSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(screen.getByText(/Wallet-wide access/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({ id: "request-1", scope: "attr.wallet.secrets.*", durationHours: 24 }), { quiet: true }));
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("does not claim nobody has access when the read fails", async () => {
    vi.mocked(loadWalletSharing).mockRejectedValue(new Error("offline"));
    render(<WalletSharing />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.queryByText("No active Wallet sharing")).toBeNull();
  });
  it("confirms revocation and targets only the selected grant", async () => {
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [], grants: [{ id: "grant", request_id: "request-grant", scope: "attr.wallet.summary.*", kind: "active_grant", status: "active", action: "grant", counterpart_type: "person", counterpart_label: "Test recipient" }] });
    render(<WalletSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(mocks.revoke).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("attr.wallet.summary.*", "request-grant", { quiet: true }));
  });
  it("keeps failed decisions open for retry", async () => {
    mocks.approve.mockRejectedValue(new Error("offline"));
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [{ id: "request-2", scope: "attr.wallet.summary.*", kind: "incoming_request", status: "pending", action: "request", counterpart_type: "person" }], grants: [] });
    render(<WalletSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update access");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });
  it("blocks approvals while locked", async () => {
    mocks.vaultKey = null;
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [{ id: "request-2", scope: "attr.wallet.secrets.*", kind: "incoming_request", status: "pending", action: "request", counterpart_type: "person" }], grants: [] });
    render(<WalletSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("does not carry a revoke confirmation across refresh to another grant", async () => {
    const grant = (id: string) => ({ id, request_id: id, scope: "attr.wallet.summary.*", kind: "active_grant" as const, status: "active", action: "grant", counterpart_type: "person" as const, counterpart_label: id });
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [], grants: [grant("First"), grant("Second")] });
    render(<WalletSharing />);
    await screen.findByText("First");
    fireEvent.click(screen.getAllByRole("button", { name: "Manage" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Manage" })[1]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("never offers a scope-wide revoke when the request ID is missing", async () => {
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [], grants: [{ id: "grant", scope: "attr.wallet.summary.*", kind: "active_grant", status: "active", action: "grant", counterpart_type: "person" }] });
    render(<WalletSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(screen.getByRole("button", { name: "Revoke access" })).toBeDisabled();
  });

  it("keeps guide and sections visible while loading and allows retry after timeout", async () => {
    vi.useFakeTimers();
    try {
      let finishOldRead!: (value: Awaited<ReturnType<typeof loadWalletSharing>>) => void;
      vi.mocked(loadWalletSharing).mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve; }));
      render(<WalletSharing />);
      expect(screen.getByRole("region", { name: "Requests" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Shared with" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Sharing guide" })).toBeVisible();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
      expect(screen.queryByText("No active Wallet sharing")).toBeNull();
      vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [], grants: [] });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
      expect(screen.getByText("No active Wallet sharing")).toBeVisible();
      await act(async () => { finishOldRead({ requests: [{ id: "late", scope: "attr.wallet.summary.*", kind: "incoming_request", status: "pending", action: "request", counterpart_type: "person", counterpart_label: "Old response" }], grants: [] }); });
      expect(screen.queryByText("Old response")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("filters real requests by category and recipient", async () => {
    const row = (id: string, scope: string, name: string) => ({ id, scope, kind: "incoming_request" as const, status: "pending", action: "request", counterpart_type: "person" as const, counterpart_label: name });
    vi.mocked(loadWalletSharing).mockResolvedValue({ requests: [row("a", "attr.wallet.summary.*", "Alex"), row("b", "attr.wallet.secrets.*", "Sam")], grants: [] });
    render(<WalletSharing />);
    await screen.findByText("Alex");
    fireEvent.click(screen.getByRole("button", { name: "Full details", exact: true }));
    expect(screen.queryByText("Alex")).toBeNull();
    expect(screen.getByText("Sam")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search recipients" }), { target: { value: "Alex" } });
    expect(screen.queryByText("Sam")).toBeNull();
  });

});
