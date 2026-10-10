import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ uid: "bob", key: "vault-key" as string | null, token: "owner-token" as string | null, open: vi.fn(), directory: vi.fn(), state: vi.fn(), error: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: mocks.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.key, getVaultOwnerToken: () => mocks.token }) }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listRecipientsPage: mocks.directory, getState: mocks.state } }));
vi.mock("@/lib/wallet/wallet-card-share", () => ({ openWalletCardShare: mocks.open }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: mocks.error } }));
import { WalletSharedCardMessage } from "@/components/wallet/wallet-shared-card-message";
const props = { content: "encrypted-card-envelope", peerPersonRef: "person-alice", senderIsViewer: false };
const card = { pan: "4111111111111111", cardholderName: "Alice", brand: "visa" as const, expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" };
describe("encrypted card message viewer", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.uid = "bob"; mocks.key = "vault-key"; mocks.token = "owner-token";
    mocks.directory.mockResolvedValue({ items: [{ userId: "alice", publicPersonRef: "person-alice" }], hasMore: false });
    mocks.state.mockResolvedValue({ myRecipientKey: null }); mocks.open.mockResolvedValue(card);
  });
  it("keeps the preview private, opens explicitly for the authenticated peer, and hides on demand", async () => {
    render(<WalletSharedCardMessage {...props} />);
    expect(document.body).not.toHaveTextContent(card.pan); expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View card details" }));
    await screen.findByRole("button", { name: "Hide card" });
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ userId: "bob", peerUserId: "alice", senderIsViewer: false }));
    expect(screen.getByTestId("wallet-card-face")).toHaveTextContent("4111");
    fireEvent.click(screen.getByRole("button", { name: "Hide card" }));
    expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  });
  it.each(["owner", "lock", "peer", "visibility", "unmount"])("discards delayed plaintext after %s changes", async boundary => {
    let finish!: (value: typeof card) => void;
    mocks.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<WalletSharedCardMessage {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View card details" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "owner") { mocks.uid = "charlie"; view.rerender(<WalletSharedCardMessage {...props} />); }
    if (boundary === "lock") { mocks.key = null; mocks.token = null; view.rerender(<WalletSharedCardMessage {...props} />); }
    if (boundary === "peer") view.rerender(<WalletSharedCardMessage {...props} peerPersonRef="person-other" />);
    if (boundary === "visibility") { vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange")); }
    if (boundary === "unmount") view.unmount();
    await act(async () => finish(card));
    expect(screen.queryByTestId("wallet-card-face")).toBeNull(); expect(mocks.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
