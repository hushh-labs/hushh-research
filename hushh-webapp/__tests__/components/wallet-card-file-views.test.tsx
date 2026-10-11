import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), prepare: vi.fn(), share: vi.fn(), state: vi.fn(), directory: vi.fn(), success: vi.fn(), error: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/wallet/wallet-card-file", () => ({ readEncryptedCardFile: mocks.read, openEncryptedCardFile: mocks.open }));
vi.mock("@/lib/services/wallet-card-access-service", () => ({ WalletCardAccessService: { state: mocks.state, recipients: mocks.directory, share: mocks.share } }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { prepareCardSharing: mocks.prepare, listCardShareReceipts: async () => [] } }));
vi.mock("@/lib/share/app-origin", () => ({ resolveShareableAppOrigin: mocks.origin }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => null }));
import { WalletEncryptedCardViewer } from "@/components/wallet/wallet-encrypted-card-viewer";
import { WalletSavedCardSharing } from "@/components/wallet/wallet-saved-card-sharing";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
const card = { pan: "4111111111111111", cardholderName: "Synthetic Person", brand: "visa" as const, expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" };
const summary = { cardId: "card_example", nickname: "", last4: "1111", brand: "visa" as const, expiryMonth: 4, expiryYear: 2030, issuingRegion: "US", createdAt: "" };
const file = new File(["encrypted"], "encrypted-card.json");
let current = true;
const context = { userId: "alice", vaultKey: "key", vaultOwnerToken: "token", getIdToken: async () => "id-token", isCurrent: () => current };
const getContext = () => context;
beforeEach(() => {
  vi.clearAllMocks(); current = true;
  mocks.read.mockResolvedValue({}); mocks.open.mockResolvedValue(card); mocks.prepare.mockResolvedValue(undefined); mocks.share.mockResolvedValue({ grants: [] });
  mocks.state.mockResolvedValue({ eligible: false, grants: [] });
  mocks.directory.mockResolvedValue({ items: [{ personRef: "person_bob", displayName: "Bob", photoUrl: null, trusted: false }], hasMore: false });
  mocks.origin.mockReturnValue("https://example.test");
});
afterEach(() => vi.restoreAllMocks());
async function selectRecipient() {
  render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: /Share card/ }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Share with Bob" }));
}
describe("temporary card access", () => {
  it("refreshes an existing card without a verification prompt and preserves the request ID on retry", async () => {
    mocks.share.mockRejectedValueOnce(new Error("Response lost"));
    await selectRecipient();
    fireEvent.click(screen.getByRole("button", { name: "15 minutes" }));
    fireEvent.click(screen.getByRole("button", { name: "Share with 1", exact: true }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    const requestId = mocks.share.mock.calls[0][4];
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ cardId: summary.cardId, userId: "alice" }));
    expect(mocks.share).toHaveBeenCalledWith(expect.any(Object), summary.cardId, ["person_bob"], 15, requestId);
    expect(mocks.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share with 1", exact: true }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Card shared."));
    expect(mocks.share.mock.calls[1][4]).toBe(requestId);
  });
  it.each(["back", "scope"])("does not send after %s changes during card preparation", async boundary => {
    let finish!: () => void;
    mocks.prepare.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await selectRecipient();
    fireEvent.click(screen.getByRole("button", { name: "Share with 1", exact: true }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "back") act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    else current = false;
    await act(async () => finish());
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
describe("anonymous local encrypted-file reader", () => {
  it.each(["password", "file", "visibility", "unmount"])("discards delayed plaintext after %s changes", async boundary => {
    let finish!: (value: typeof card) => void; mocks.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<WalletEncryptedCardViewer />);
    fireEvent.change(screen.getByLabelText("Encrypted card file"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("Password", { exact: true })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "synthetic-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Open card", exact: true }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "password") fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "changed-password" } });
    if (boundary === "file") fireEvent.change(screen.getByLabelText("Encrypted card file"), { target: { files: [new File(["other"], "other.json")] } });
    if (boundary === "visibility") { vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange")); }
    if (boundary === "unmount") view.unmount();
    await act(async () => finish(card));
    expect(screen.queryByRole("region", { name: "Shared card details" })).toBeNull(); expect(mocks.error).not.toHaveBeenCalled();
  });
});
