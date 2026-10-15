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
const packet = { packetId: person, version: 2, listingRevision: 3, title: "Example Bank statements",
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
  it("discards a late private packet response after the authenticated owner changes", async () => {
    let resolve!: (value: unknown) => void;
    state.packets.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ packets: [], nextCursor: null });
    const view = render(<DrivePacketCatalog />);
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(1));
    state.uid = "new-owner"; state.token = "new-token"; publishValidatedAuthSessionOwner("new-owner");
    view.rerender(<DrivePacketCatalog />);
    await act(async () => resolve({ packets: [packet], nextCursor: null }));
    expect(screen.queryByText("Example Bank statements")).toBeNull();
  });
  it("keeps preparation off until the owner changes the saved switch, with distinct counts under details", async () => {
    state.setProcessing.mockResolvedValue({ ...status, enabled: true, state: "indexing", revision: 1 });
    render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(state.setProcessing).not.toHaveBeenCalled();
    expect(screen.getByText("No files indexed yet.").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getAllByText("View details")[0]);
    expect(screen.getByText("discovered").nextElementSibling).toHaveTextContent("1,035");
    expect(screen.getByText("indexed").nextElementSibling).toHaveTextContent("0");
    fireEvent.click(toggle);
    await waitFor(() => expect(state.setProcessing).toHaveBeenCalledWith("private-token", true, expect.any(Function)));
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
  it("keeps prepared packets visible when preparation is paused without claiming current work", async () => {
    state.collection.mockResolvedValue({ ...status, enabled: false, state: "paused" });
    const view = render(<DriveCollectionPanel backgroundEnabled />);
    expect(await screen.findByText("Example Bank statements")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Prepare packets" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Agent One is preparing your packets.")).toBeNull();
    view.unmount();
    state.packets.mockResolvedValue({ packets: [], nextCursor: null });
    render(<DriveCollectionPanel backgroundEnabled={false} />);
    expect(await screen.findByText("Preparation paused")).toBeInTheDocument();
    expect(screen.queryByText("Agent One is preparing your packets.")).toBeNull();
    expect(state.setProcessing).not.toHaveBeenCalled();
  });
  it("finishes a preparation decision when background access changes during the request", async () => {
    let finish!: (value: unknown) => void;
    state.setProcessing.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await screen.findByText("Saving…");
    view.rerender(<DriveCollectionPanel backgroundEnabled={false} />);
    await act(async () => finish({ ...status, enabled: true, state: "paused", revision: 1 }));
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
