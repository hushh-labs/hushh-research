import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ uid: "owner", token: "private-token", unlocked: true,
  packets: vi.fn(), listing: vi.fn(), request: vi.fn(), collection: vi.fn(), setProcessing: vi.fn(), identity: vi.fn(), linkIdentity: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }) }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: state }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { documentRequestIdentityToken: state.identity, linkGoogleIdentity: state.linkIdentity } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ openExternalUrl: state.openExternal }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: { appIsActive: true, shielded: false } }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/profile" }));
import { DrivePacketCatalog, ownerPacketSections } from "@/components/consent/drive-packet-catalog";
import { useNativeConnectors } from "@/components/profile/use-native-connectors";
import type { ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import type { NativeDrawerChoice } from "@/lib/capacitor/native-drawers";
import type { DrivePacket } from "@/lib/services/drive-packet-service";
import { DriveCollectionPanel } from "@/components/agent/drive-collection-panel";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
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
  for (const mock of [state.packets, state.listing, state.request, state.collection, state.setProcessing, state.identity, state.linkIdentity, state.openExternal]) mock.mockReset();
  state.uid = "owner"; state.token = "private-token"; state.unlocked = true;
  publishValidatedAuthSessionOwner("owner");
  state.identity.mockImplementation(async (_uid, current) => { if (!current()) throw new Error("session_changed"); return "firebase-token"; });
  state.linkIdentity.mockResolvedValue("linked-firebase-token");
  state.packets.mockImplementation(async (_token, guard) => { guard(); return { packets: [packet], nextCursor: null }; });
  state.listing.mockResolvedValue({});
  state.collection.mockImplementation(async (_token, guard) => { guard(); return status; });
});
afterEach(() => { cleanup(); advanceVaultSessionEpoch(); publishValidatedAuthSessionOwner(null); });
describe("agent prepared packets", () => {
  it("shows four owner category entrypoints before packets exist without starting preparation", async () => {
    state.packets.mockResolvedValue({ packets: [], nextCursor: null });
    render(<DrivePacketCatalog periodPackets />);
    for (const name of ["Financial statements", "Account statements", "Brokerage", "Insurance"])
      expect(screen.getByRole("button", { name: `Open ${name}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Brokerage" }));
    expect(screen.getByText("No packets yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Buy|List for/ })).toBeNull();
    await waitFor(() => expect(state.packets).toHaveBeenCalledOnce());
    expect(state.setProcessing).not.toHaveBeenCalled();
  });
  it("uses the existing native packet page for categories and periods and retires old actions", async () => {
    const current = { kind: "provider_discovery", category: "bank", packetId: person, version: 0,
      title: "Account statements", periodStart: "2026-09-01", periodEnd: "2026-10-31", state: "building",
      listingRevision: 0, documentCount: 2, priceCents: 500, canList: false, listingEnabled: false };
    const open = vi.fn();
    const model = { catalog: { status: "ready", groups: [], query: "" }, selectedConnector: { id: "google_drive", name: "Google Drive" }, detail: {
      kind: "drive", account: "Example account", status: "Connected", actions: [], notes: [], files: [], message: "", collection: null,
      mutationPending: () => false, packets: { enabled: true, packets: [
        { ...current, packetId: "closed", periodStart: "2026-07-01", periodEnd: "2026-08-31", state: "ready", version: 1 }, current,
      ], loaded: true, busy: false, error: false, open }, packet: { packet: null, mutationPending: () => false },
      trust: { mutationPending: () => false },
    } } as unknown as ConnectorsPanelPresentation;
    const { result, rerender } = renderHook(({ owner }) => useNativeConnectors(model, owner, true), { initialProps: { owner: "owner" } });
    const rows = () => result.current.pages.at(-1)!.sections.flatMap(section => section.rows);
    const choose = async (label: string) => { const row = rows().find(row => row.label === label)!;
      await act(async () => { await result.current.rows.get(row.id)!({ rowId: row.id } as NativeDrawerChoice); }); };
    await choose("Packets"); await choose("Account statements");
    expect(result.current.pages.map(page => page.id)).toEqual(["connectors", "connector-detail", "connector-packets"]);
    expect(rows().map(row => row.label)).toEqual(["All categories", "Sep–Oct 2026", "Jul–Aug 2026"]);
    act(() => { expect(result.current.back()).toBe(true); });
    expect(rows().some(row => row.label === "Account statements")).toBe(true);
    await choose("Account statements");
    const row = rows().find(row => row.label === "Jul–Aug 2026")!;
    const retired = result.current.rows.get(row.id)!;
    rerender({ owner: "replacement" });
    await act(async () => { await retired({ rowId: row.id } as NativeDrawerChoice); });
    expect(open).not.toHaveBeenCalled();
  });
  it("fences an original file action when its owner session retires", () => {
    let current = true;
    const viewUrl = "https://drive.google.com/file/d/example/view";
    const row = ownerPacketSections({ ...packet, contents: { period: null, documents: [
      { name: "Example.pdf", type: null, pages: null, period: null, viewUrl },
    ] } } as DrivePacket, null, () => current)[0].rows![0];
    row.onOpen!();
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(viewUrl);
    current = false; row.onOpen!();
    expect(state.openExternal).toHaveBeenCalledOnce();
  });
  it("opens default categories into newest-first periods without enabling body preparation", async () => {
    const current = { kind: "provider_discovery", packetId: person, category: "bank", version: 0,
      listingRevision: 0, title: "Account statements", description: "Drive search matches", coverageSummary: "September–October 2026",
      periodStart: "2026-09-01", periodEnd: "2026-10-31", timezone: "Asia/Kolkata", state: "building",
      documentCount: 2, freshness: "current", priceCents: 500, listingEnabled: false, canList: false, canRequest: false,
      requestId: null, purchaseState: "none" };
    const frozen = { ...current, packetId: "22222222-2222-4222-8222-222222222222", version: 1,
      periodStart: "2026-07-01", periodEnd: "2026-08-31", state: "ready", canList: true };
    state.packets.mockResolvedValue({ packets: [frozen, current, ...["financial", "brokerage", "insurance"].map((category, index) =>
      ({ ...current, category, packetId: `${index + 3}1111111-1111-4111-8111-111111111111` }))], nextCursor: null });
    render(<DrivePacketCatalog />);
    for (const name of ["Financial statements", "Account statements", "Brokerage", "Insurance"])
      expect(await screen.findByRole("button", { name: `Open ${name}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Account statements" }));
    const periods = screen.getAllByRole("button").filter(button => button.textContent?.includes("2026"));
    expect(periods.map(button => button.textContent)).toEqual([expect.stringContaining("Sep–Oct 2026"), expect.stringContaining("Jul–Aug 2026")]);
    fireEvent.click(periods[0]);
    const building = await screen.findByRole("dialog", { name: current.title });
    expect(building).toHaveTextContent("Building");
    expect(within(building).queryByRole("button", { name: /^List|Change price/ })).toBeNull();
    fireEvent.click(within(building).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Jul–Aug 2026/ }));
    const closed = await screen.findByRole("dialog", { name: current.title });
    expect(within(closed).getByRole("button", { name: "List for $5" })).toBeEnabled();
    expect(within(closed).queryByRole("button", { name: "Change price" })).toBeNull();
    fireEvent.click(within(closed).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => { expect(unwindBackLayer("/one/profile")).toBe(true); });
    expect(screen.getByRole("button", { name: "Open Account statements" })).toBeInTheDocument();
    expect(state.collection).not.toHaveBeenCalled(); expect(state.setProcessing).not.toHaveBeenCalled();
  });
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
