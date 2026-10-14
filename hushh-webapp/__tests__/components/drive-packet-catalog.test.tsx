import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ uid: "owner", token: "private-token", unlocked: true,
  packets: vi.fn(), listing: vi.fn(), request: vi.fn(), collection: vi.fn(), setProcessing: vi.fn(), identity: vi.fn(), linkIdentity: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }) }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: state }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { documentRequestIdentityToken: state.identity, linkGoogleIdentity: state.linkIdentity } }));
import { DrivePacketCatalog } from "@/components/consent/drive-packet-catalog";
import { DriveCollectionPanel } from "@/components/agent/drive-collection-panel";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
const person = "11111111-1111-4111-8111-111111111111";
const packet = { packetId: person, version: 2, listingRevision: 3, title: "Schwab statements",
  description: "Verified statements", state: "ready", coverageSummary: "September 2026", gaps: [],
  documentCount: 3, verifiedAt: "2026-10-13T10:00:00Z", freshness: "current", assessmentScore: 95,
  importance: 100, suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: false,
  canRequest: true, canList: true };
const status = { enabled: false, backgroundEnabled: true, state: "not_enabled", revision: 0,
  counts: { discovered: 1035, extracted: 0, indexed: 0, failed: 0, pending: 1035 }, initialStartedAt: null,
  initialCompletedAt: null, lastSyncedAt: null, lastIndexedAt: null, initialIndexingDurationMs: null, initialExtractionCompletedAt: null, lastExtractedAt: null,
  initialExtractionDurationMs: null, lastSemanticIndexingDurationMs: null, lastDocumentExtractionDurationMs: null, syncDurationMs: 2000 };
beforeEach(() => {
  vi.resetAllMocks(); state.uid = "owner"; state.token = "private-token"; state.unlocked = true;
  publishValidatedAuthSessionOwner("owner");
  state.identity.mockImplementation(async (_uid, current) => { if (!current()) throw new Error("session_changed"); return "firebase-token"; });
  state.linkIdentity.mockResolvedValue("linked-firebase-token");
  state.packets.mockImplementation(async (_token, guard) => { guard(); return { packets: [packet], nextCursor: null }; });
  state.listing.mockResolvedValue({});
  state.collection.mockImplementation(async (_token, guard) => { guard(); return status; });
});
afterEach(() => { cleanup(); advanceVaultSessionEpoch(); publishValidatedAuthSessionOwner(null); });
describe("agent prepared packets", () => {
  it("lets the owner Allow or Deny without choosing documents, and preserves edited cents", async () => {
    render(<DrivePacketCatalog />);
    await screen.findByText("Schwab statements");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText("Price for Schwab statements"), { target: { value: "56.78" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(state.listing).toHaveBeenCalledWith("private-token", packet, "allow", 5678, expect.any(Function)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Price for Schwab statements"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(state.listing).toHaveBeenLastCalledWith("private-token", packet, "deny", 1234, expect.any(Function)));
  });
  it("reuses the buyer request key on retry and links to already-owned access", async () => {
    state.request.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ requestId: person, existingAccess: true });
    render(<DrivePacketCatalog ownerPersonRef={person} />);
    const button = await screen.findByRole("button", { name: "Request packet · $12.34" });
    fireEvent.click(button);
    await screen.findByText("Couldn’t finish. Retry to check the latest status.");
    fireEvent.click(button);
    const link = await screen.findByRole("link", { name: "View access" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent(`document_share_request:${person}`));
    expect(state.request.mock.calls[0][3]).toBe(state.request.mock.calls[1][3]);
    expect(state.request.mock.calls[0][1]).toBe("firebase-token");
    expect(state.listing).not.toHaveBeenCalled();
  });
  it("links a missing Google identity only after the buyer explicitly asks, then retries the same packet", async () => {
    state.request.mockRejectedValueOnce(Object.assign(new Error("identity"), { code: "verify_google_identity_required" }))
      .mockResolvedValueOnce({ requestId: person, existingAccess: false });
    render(<DrivePacketCatalog ownerPersonRef={person} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request packet · $12.34" }));
    const link = await screen.findByRole("button", { name: "Add Google account" });
    expect(state.linkIdentity).not.toHaveBeenCalled();
    fireEvent.click(link);
    await screen.findByRole("link", { name: "View request" });
    expect(state.linkIdentity).toHaveBeenCalledWith("owner", expect.any(Function));
    expect(state.request.mock.calls[1][1]).toBe("linked-firebase-token");
    expect(state.request.mock.calls[1][3]).toBe(state.request.mock.calls[0][3]);
  });
  it("discards a late private packet response after the authenticated owner changes", async () => {
    let resolve!: (value: unknown) => void;
    state.packets.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ packets: [], nextCursor: null });
    const view = render(<DrivePacketCatalog />);
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(1));
    state.uid = "new-owner"; state.token = "new-token"; publishValidatedAuthSessionOwner("new-owner");
    view.rerender(<DrivePacketCatalog />);
    await act(async () => resolve({ packets: [packet], nextCursor: null }));
    expect(screen.queryByText("Schwab statements")).toBeNull();
  });
  it("reports discovered and indexed counts separately before enabling preparation", async () => {
    state.setProcessing.mockResolvedValue({ ...status, enabled: true, state: "indexing", revision: 1 });
    render(<DriveCollectionPanel backgroundEnabled />);
    await screen.findByText("No files indexed yet.");
    fireEvent.click(screen.getByRole("button", { name: "Allow preparation" }));
    await waitFor(() => expect(state.setProcessing).toHaveBeenCalledWith("private-token", true, expect.any(Function)));
    expect(await screen.findByRole("button", { name: "Pause preparation" })).toBeInTheDocument();
  });
  it("finishes a preparation decision when background access changes during the request", async () => {
    let finish!: (value: unknown) => void;
    state.setProcessing.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<DriveCollectionPanel backgroundEnabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow preparation" }));
    await screen.findByRole("button", { name: "Saving…" });
    view.rerender(<DriveCollectionPanel backgroundEnabled={false} />);
    await act(async () => finish({ ...status, enabled: true, state: "paused", revision: 1 }));
    expect(await screen.findByRole("button", { name: "Pause preparation" })).not.toBeDisabled();
  });
});
