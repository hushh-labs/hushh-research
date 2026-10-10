import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), prepare: vi.fn(), share: vi.fn(), directory: vi.fn(), success: vi.fn(), error: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/wallet/wallet-card-file", () => ({ readEncryptedCardFile: mocks.read, openEncryptedCardFile: mocks.open }));
vi.mock("@/lib/services/wallet-card-share-service", () => ({ prepareSavedCardFile: mocks.prepare, findCardShareRecipients: mocks.directory, shareSavedCard: vi.fn() }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { listCardShareReceipts: async () => [] } }));
vi.mock("@/lib/share/share-file", () => ({ shareFile: mocks.share }));
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
  vi.resetAllMocks(); current = true;
  mocks.read.mockResolvedValue({}); mocks.open.mockResolvedValue(card); mocks.prepare.mockResolvedValue(file); mocks.share.mockResolvedValue("download");
  mocks.origin.mockReturnValue("https://example.test");
});
afterEach(() => vi.restoreAllMocks());
function fillExport() {
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "synthetic-long-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "synthetic-long-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare encrypted file" }));
}
describe("account-independent encrypted card sharing", () => {
  it("does not embed a native or loopback reader address when a public app origin is missing", async () => {
    mocks.origin.mockReturnValue(null);
    render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Share card", exact: true })); fillExport();
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.share).not.toHaveBeenCalled();
  });
  it("keeps all new-prepare controls disabled while a share sheet is pending", async () => {
    let finish!: (value: string) => void; mocks.share.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Share card", exact: true })); fillExport();
    fireEvent.click(await screen.findByRole("button", { name: "Share encrypted file" }));
    expect(screen.getByRole("button", { name: "Use another password" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Share card", exact: true })).toBeDisabled();
    await act(async () => finish("web-share"));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("prepares first, clears passwords, then shares on a separate click without searching people or claiming delivery", async () => {
    render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Share card", exact: true })); fillExport();
    const share = await screen.findByRole("button", { name: "Share encrypted file" });
    expect(screen.queryByLabelText("Password", { exact: true })).toBeNull(); expect(mocks.directory).not.toHaveBeenCalled(); expect(mocks.share).not.toHaveBeenCalled();
    fireEvent.click(share);
    expect(mocks.share).toHaveBeenCalledWith({ file, title: "Encrypted card" });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Encrypted file downloaded."));
    expect(screen.getByText("Not shared with anyone yet")).toBeVisible();
  });
  it("does not announce a send or error when the share sheet is dismissed", async () => {
    mocks.share.mockRejectedValue(new DOMException("Dismissed", "AbortError"));
    render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Share card", exact: true })); fillExport();
    fireEvent.click(await screen.findByRole("button", { name: "Share encrypted file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Share encrypted file" })).toBeEnabled());
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  });
  it.each(["password", "back", "scope"])("drops a prepared file after %s changes", async boundary => {
    let finish!: (value: File) => void; mocks.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<WalletSavedCardSharing card={summary} getContext={getContext} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Share card", exact: true })); fillExport();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "password") fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "another-long-password" } });
    if (boundary === "back") act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    if (boundary === "scope") current = false;
    await act(async () => finish(file));
    expect(screen.queryByRole("button", { name: "Share encrypted file" })).toBeNull(); expect(mocks.share).not.toHaveBeenCalled();
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
