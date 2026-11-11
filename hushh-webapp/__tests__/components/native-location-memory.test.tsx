import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  phase: "native" as "native" | "web" | "checking", requested: true, held: false, reason: "active", epoch: 1,
  privacy: { generation: 1, shielded: false, appIsActive: true },
  args: null as null | { active: boolean; content: { sections: Array<{ rows: Array<{ id: string; label: string }> }>; search?: { id: string; query: string } }; actions: Map<string, (choice: { text?: string }) => void | Promise<void>> },
  retire: vi.fn<() => Promise<boolean>>(), navigate: vi.fn(), model: null as null | Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/pkm/location/" }));
vi.mock("@/components/profile/use-pkm-natural-model", () => ({ usePkmNaturalModel: () => m.model }));
vi.mock("@/components/profile/pkm-natural-panel", () => ({ PkmNaturalPanelBody: ({ locationSearch }: { locationSearch: { query: string } }) => <div>React fallback query: {locationSearch.query}</div> }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => <div>Native Location</div> }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: m.privacy }), nativePrivacyCanInteract: (state: typeof m.privacy) => state.appIsActive && !state.shielded, subscribeNativePrivacyObservation: () => () => {} }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => m.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch, subscribeVaultSessionEpoch: () => () => {} }));
vi.mock("@/lib/capitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => m.requested }));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { held: m.held, reason: m.reason }, retireForWeb: m.retire }),
  useNativeWorkspace: (args: typeof m.args) => { m.args = args; return m.phase; },
}));
import { NativeLocationMemory } from "@/app/one/pkm/location/native-location-memory";
import * as policy from "@/lib/capacitor/native-presentation-policy";

beforeEach(() => {
  m.phase = "native"; m.requested = true; m.held = false; m.reason = "active"; m.epoch = 1;
  vi.spyOn(policy, "customNativePresentationEnabled").mockImplementation(() => m.requested);
  m.privacy = { generation: 1, shielded: false, appIsActive: true }; m.args = null;
  m.retire.mockReset().mockResolvedValue(true); m.navigate.mockReset();
  m.model = { ownerId: "owner", presentationIdentity: Symbol("unlocked"), authLoading: false, canOpen: true, sessionVerificationRequired: false,
    captureSessionCurrent: () => true, locationLoading: false, bootstrapError: false, domainDetail: { error: false },
    locationPresentation: { incomplete: false, sections: [{ key: "place", title: "Place", fields: [
      { label: "Name", value: "Synthetic", selector: "0123456789abcdef", card: { pathSegments: ["place", "name"], valueFingerprint: "one" } },
      { label: "City", value: "Example", selector: null, card: { pathSegments: ["place", "city"], valueFingerprint: "two" } },
    ] }] }, signedIn: true, nativeDataState: "loaded", navigate: m.navigate };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("retains live search in fallback and clears it on vault lock", async () => {
  const view = render(<NativeLocationMemory />);
  await act(async () => { await m.args!.actions.get(m.args!.content.search!.id)!({ text: "synthetic" }); });
  expect(m.args!.content.search!.query).toBe("synthetic");
  m.phase = "web"; m.reason = "unsupported";
  view.rerender(<NativeLocationMemory />);
  expect(screen.getByText("React fallback query: synthetic")).toBeTruthy();
  m.model!.canOpen = false;
  view.rerender(<NativeLocationMemory />);
  expect(screen.getByText("React fallback query:")).toBeTruthy();
});

it("retires before opening the detail and rejects a stale vault", async () => {
  let release!: (value: boolean) => void;
  m.retire.mockReturnValue(new Promise(resolve => { release = resolve; }));
  render(<NativeLocationMemory />);
  const action = m.args!.actions.get(m.args!.content.sections[0].rows[0].id)!({});
  expect(m.navigate).not.toHaveBeenCalled();
  await act(async () => { release(true); await action; });
  expect(m.navigate).toHaveBeenCalledWith("/one/pkm/location/detail?memory=0123456789abcdef");
  cleanup(); m.navigate.mockReset(); m.retire.mockImplementation(async () => { m.epoch++; return true; });
  render(<NativeLocationMemory />);
  await act(async () => { await m.args!.actions.get(m.args!.content.sections[0].rows[0].id)!({}); });
  expect(m.navigate).not.toHaveBeenCalled();
});

it("does not retain an unopened detail handoff after a vault lock", async () => {
  const view = render(<NativeLocationMemory />);
  await act(async () => { await m.args!.actions.get(m.args!.content.sections[0].rows[0].id)!({}); });
  expect(m.args!.active).toBe(false);
  m.model = { ...m.model, canOpen: false, presentationIdentity: Symbol("locked") };
  view.rerender(<NativeLocationMemory />);
  m.model = { ...m.model, canOpen: true, presentationIdentity: Symbol("unlocked-again") };
  view.rerender(<NativeLocationMemory />);
  expect(m.args!.active).toBe(true);
});

it("does not open a detail captured by an older presentation session", async () => {
  let release!: (value: boolean) => void;
  m.retire.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const view = render(<NativeLocationMemory />);
  const action = m.args!.actions.get(m.args!.content.sections[0].rows[0].id)!({});
  m.model = { ...m.model, presentationIdentity: Symbol("new-unlock") };
  view.rerender(<NativeLocationMemory />);
  await act(async () => { release(true); await action; });
  expect(m.navigate).not.toHaveBeenCalled();
});

it("keeps flag-off React without native handles and avoids a loading flash", () => {
  m.requested = false; m.phase = "web";
  const uuid = vi.spyOn(crypto, "randomUUID");
  const view = render(<NativeLocationMemory />);
  expect(screen.getByText("React fallback query:")).toBeTruthy();
  expect(uuid).not.toHaveBeenCalled();
  m.requested = true; m.reason = "inactive"; m.model!.locationLoading = true;
  view.rerender(<NativeLocationMemory />);
  expect(screen.queryByText("React fallback query:")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Opening Location memory…");
});
