import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ uid: "owner", ownerId: "owner", visibility: vi.fn(), setVisibility: vi.fn(), privateCatalog: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid }, userId: state.ownerId }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "vault-owner-token", isVaultUnlocked: true }) }));
vi.mock("@/lib/services/financial-packet-summary-service", () => ({ FinancialPacketSummaryService: state }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: { packets: state.privateCatalog } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/profile" }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: { appIsActive: true, shielded: false } }) }));
import { usePacketPublications, PacketPublicationsView } from "@/components/consent/packets/packet-publications";
import { useNativeConnectors } from "@/components/profile/use-native-connectors";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import type { NativeDrawerChoice } from "@/lib/capacitor/native-drawers";
const preference = { enabled: true, revision: 0, disclosure: "drive-financial-summary-default-v1" as const };
beforeEach(() => {
  vi.clearAllMocks(); state.uid = "owner"; state.ownerId = "owner";
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  state.visibility.mockImplementation(async (_token, guard) => { guard(); return preference; });
  state.setVisibility.mockImplementation(async (_token, expected, enabled, guard) => { guard(); return { ...expected, enabled, revision: expected.revision + 1 }; });
});
afterEach(() => { cleanup(); advanceVaultSessionEpoch(); publishValidatedAuthSessionPrincipal(null); });
function Manager() { return <PacketPublicationsView model={usePacketPublications(true)} />; }
describe("@feature_drive_packets @trace_loop owner profile visibility", () => {
  it("reads one default-on preference and saves an explicit hide without Drive OAuth or a private catalog", async () => {
    const view = render(<Manager />);
    const toggle = await screen.findByRole("switch", { name: "Show on profile" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByText(/Files stay private until you approve a request/)).toBeInTheDocument();
    state.visibility.mockImplementation(async (_token, guard) => { guard(); return { ...preference, enabled: false, revision: 1 }; });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(state.setVisibility).toHaveBeenCalledExactlyOnceWith("vault-owner-token", preference, false, expect.any(Function));
    expect(state.privateCatalog).not.toHaveBeenCalled();
    await waitFor(() => expect(toggle).toBeEnabled());
    view.unmount();
    render(<Manager />);
    const warmToggle = screen.getByRole("switch", { name: "Show on profile" });
    expect(warmToggle).not.toBeChecked();
    await waitFor(() => expect(warmToggle).toBeEnabled());
  });
  it("preserves explicit hidden on cold mount and cannot write before the authoritative preference arrives", async () => {
    let release!: (value: unknown) => void;
    state.visibility.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    render(<Manager />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(state.setVisibility).not.toHaveBeenCalled();
    await act(async () => release({ ...preference, enabled: false, revision: 8 }));
    const toggle = await screen.findByRole("switch", { name: "Show on profile" });
    expect(toggle).toBeEnabled(); expect(toggle).not.toBeChecked();
    expect(state.setVisibility).not.toHaveBeenCalled();
  });
  it("rejects retired same-Firebase callbacks after the account generation changes", async () => {
    state.ownerId = `acct_${"1".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 1 });
    const { result, rerender } = renderHook(() => usePacketPublications(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const retired = result.current.setEnabled;
    state.ownerId = `acct_${"2".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 2 });
    rerender(); await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => retired(false));
    expect(state.setVisibility).not.toHaveBeenCalled();
    expect(result.current.preference).toEqual(preference);
  });
  it("does not expose a previous owner's delayed preference", async () => {
    let release!: (value: unknown) => void;
    state.visibility.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result, rerender } = renderHook(() => usePacketPublications(true));
    await waitFor(() => expect(state.visibility).toHaveBeenCalledTimes(1));
    state.uid = "replacement"; state.ownerId = "replacement";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
    state.visibility.mockImplementation(async (_token, guard) => { guard(); return { ...preference, revision: 3 }; });
    rerender(); await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => release({ ...preference, enabled: false, revision: 99 }));
    expect(result.current.preference).toEqual({ ...preference, revision: 3 });
    expect(state.setVisibility).not.toHaveBeenCalled();
  });
  it("offers the same single switch in disconnected native Drive details and rejects a retired owner's callback", async () => {
    const { result, rerender } = renderHook(() => {
      const publications = usePacketPublications(true);
      const model = { catalog: { status: "ready", groups: [], query: "" }, selectedConnector: { id: "google_drive", name: "Google Drive" }, detail: {
        kind: "drive", account: "Google Drive", status: "Not connected", connected: false, busy: false, message: "", actions: [], notes: [], files: [],
        background: null, selection: null, collection: null, groups: null, packets: { enabled: false }, publications,
        packet: { mutationPending: () => false }, trust: { mutationPending: () => false }, mutationPending: publications.mutationPending,
      } } as unknown as ConnectorsPanelPresentation;
      return useNativeConnectors(model, state.uid, true);
    });
    const visibilityRows = () => result.current.pages.flatMap(page => page.sections).flatMap(section => section.rows).filter(row => row.label === "Show on profile");
    await waitFor(() => expect(visibilityRows()[0]?.toggle).toBe(true));
    expect(visibilityRows()).toHaveLength(1);
    const row = visibilityRows()[0], off = row.options!.find(option => option.label === "Off")!;
    const retired = result.current.rows.get(off.id)!;
    state.uid = "replacement"; state.ownerId = "replacement";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 }); rerender();
    await act(async () => retired({ rowId: off.id } as NativeDrawerChoice));
    expect(state.setVisibility).not.toHaveBeenCalled(); expect(state.privateCatalog).not.toHaveBeenCalled();
  });
});
