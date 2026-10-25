import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ uid: "owner", ownerId: "owner", publications: vi.fn(), publish: vi.fn(), privateCatalog: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid }, userId: state.ownerId }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "vault-owner-token", isVaultUnlocked: true }) }));
vi.mock("@/lib/services/financial-packet-summary-service", () => ({ FinancialPacketSummaryService: state }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: { packets: state.privateCatalog } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/profile" }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: { appIsActive: true, shielded: false } }) }));
import { usePacketPublications, PacketPublicationsView } from "@/components/consent/packets/packet-publications";
import { useNativeConnectors } from "@/components/profile/use-native-connectors";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import type { PacketPublication } from "@/lib/services/financial-packet-summary-service";
import type { ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import type { NativeDrawerChoice } from "@/lib/capacitor/native-drawers";
const receipt: PacketPublication = { packetId: "22222222-2222-4222-8222-222222222222", currentVersion: 1, title: "Financial documents",
  periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "Asia/Kolkata",
  publicSummary: { enabled: true, revision: 9, version: 0, disclosure: "drive-packet-public-summary-v1" } };
beforeEach(() => {
  vi.clearAllMocks(); state.uid = "owner"; state.ownerId = "owner"; publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  state.publications.mockImplementation(async (_token, guard) => { guard(); return { packets: [receipt], nextCursor: null }; });
  state.publish.mockImplementation(async (_token, _id, expected, _enabled, guard) => { guard(); return { ...expected, enabled: false, revision: 10 }; });
});
afterEach(cleanup);
function Manager() { return <PacketPublicationsView model={usePacketPublications(true)} />; }
describe("@feature_drive_packets @trace_loop cold publication withdrawal", () => {
  it("loads scalar receipts on cold mount and hides an old-version publication without Drive OAuth or a private catalog", async () => {
    render(<Manager />);
    const button = await screen.findByRole("button", { name: "Hide public summary" });
    expect(screen.getByText(/A saved publication may already be inactive/)).toBeInTheDocument();
    state.publications.mockImplementation(async (_token, guard) => { guard(); return { packets: [], nextCursor: null }; });
    fireEvent.click(button);
    await screen.findByText("Public summary hidden.");
    expect(state.publish).toHaveBeenCalledWith("vault-owner-token", receipt.packetId, receipt.publicSummary, false, expect.any(Function));
    expect(await screen.findByText("No saved publications")).toBeInTheDocument();
    expect(state.privateCatalog).not.toHaveBeenCalled();
  });
  it("withdraws for a new account generation and rejects a retired same-Firebase callback", async () => {
    state.ownerId = `acct_${"1".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 1 });
    const { result, rerender } = renderHook(() => usePacketPublications(true));
    await waitFor(() => expect(result.current.packets).toHaveLength(1));
    const retired = result.current.hide;
    state.publications.mockImplementation(async (_token, guard) => { guard(); return { packets: [], nextCursor: null }; });
    await act(async () => result.current.hide(receipt));
    expect(state.publish).toHaveBeenCalledTimes(1);
    state.ownerId = `acct_${"2".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 2 });
    rerender(); await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => retired(receipt));
    expect(state.publish).toHaveBeenCalledTimes(1);
    expect(result.current.packets).toEqual([]);
    expect(state.privateCatalog).not.toHaveBeenCalled();
  });
  it("does not expose a previous owner's delayed scalar receipts", async () => {
    let release!: (value: unknown) => void;
    state.publications.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result, rerender } = renderHook(() => usePacketPublications(true));
    await waitFor(() => expect(state.publications).toHaveBeenCalledTimes(1));
    state.uid = "replacement"; state.ownerId = "replacement"; publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
    state.publications.mockImplementation(async (_token, guard) => { guard(); return { packets: [], nextCursor: null }; });
    rerender(); await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => release({ packets: [receipt], nextCursor: null }));
    expect(result.current.packets).toEqual([]); expect(state.publish).not.toHaveBeenCalled();
  });
  it("exposes the same hide action in a disconnected native Drive detail and rejects a retired owner's callback", async () => {
    const { result, rerender } = renderHook(() => {
      const publications = usePacketPublications(true);
      const model = { catalog: { status: "ready", groups: [], query: "" }, selectedConnector: { id: "google_drive", name: "Google Drive" }, detail: {
        kind: "drive", account: "Google Drive", status: "Not connected", connected: false, busy: false, message: "", actions: [], notes: [], files: [],
        background: null, selection: null, collection: null, groups: null, packets: { enabled: false }, publications,
        packet: { mutationPending: () => false }, trust: { mutationPending: () => false }, mutationPending: publications.mutationPending,
      } } as unknown as ConnectorsPanelPresentation;
      return useNativeConnectors(model, state.uid, true);
    });
    const hideRow = () => result.current.pages.flatMap(page => page.sections).flatMap(section => section.rows).find(row => row.label === "Hide public summary");
    await waitFor(() => expect(hideRow()).toBeDefined());
    const row = hideRow()!, retired = result.current.rows.get(row.id)!;
    state.uid = "replacement"; state.ownerId = "replacement"; publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 }); rerender();
    await act(async () => retired({ rowId: row.id } as NativeDrawerChoice));
    expect(state.publish).not.toHaveBeenCalled(); expect(state.privateCatalog).not.toHaveBeenCalled();
  });
});
