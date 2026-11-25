import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  phase: "native" as "native" | "web" | "checking" | "blocked", held: false, requested: true, reason: "active",
  pathname: "/one/pkm/recent", epoch: 1, privacy: { generation: 1, shielded: false, appIsActive: true },
  args: null as null | { active: boolean; content: { sections: Array<{ rows: Array<{ id: string; label: string }> }> }; actions: Map<string, () => Promise<void>> },
  retire: vi.fn<() => Promise<boolean>>(), open: vi.fn(),
  model: null as null | Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => m.pathname }));
vi.mock("@/components/profile/use-pkm-natural-model", () => ({ usePkmNaturalModel: () => m.model }));
vi.mock("@/components/profile/pkm-natural-panel", () => ({ PkmNaturalPanelBody: () => <div>Complete React detail</div> }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => <div>Native recent list</div> }));
vi.mock("@/lib/pkm/pkm-memory-cards", () => ({ pkmMemoryRowLabels: (card: { title: string; value: string }) => ({ primary: card.title, secondary: card.value }) }));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ state: m.privacy }), nativePrivacyCanInteract: (state: typeof m.privacy) => state.appIsActive && !state.shielded }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => m.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => m.requested }));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { held: m.held, reason: m.reason }, retireForWeb: m.retire }),
  useNativeWorkspace: (args: typeof m.args) => { m.args = args; return m.phase; },
}));
import { NativeRecentMemory } from "@/app/one/pkm/recent/native-recent-memory";

beforeEach(() => {
  m.phase = "native"; m.held = false; m.requested = true; m.reason = "active"; m.pathname = "/one/pkm/recent"; m.epoch = 1;
  m.privacy = { generation: 1, shielded: false, appIsActive: true }; m.args = null;
  m.retire.mockReset().mockResolvedValue(true); m.open.mockReset();
  m.model = { ownerId: "owner", authLoading: false, canOpen: true, captureSessionCurrent: () => true,
    recentMemories: [{ id: "private-card-id", title: "Synthetic item", value: "Synthetic value" }], selectedCard: null,
    signedIn: true, nativeDataState: "loaded", openMemory: m.open };
});
afterEach(cleanup);

it("keeps the existing detail hidden until native retirement and opens the current card", async () => {
  let release!: (value: boolean) => void;
  m.retire.mockReturnValue(new Promise(resolve => { release = resolve; }));
  render(<NativeRecentMemory />);
  expect(screen.getByText("Native recent list")).toBeTruthy();
  expect(m.args?.active).toBe(true);
  const row = m.args!.content.sections[0].rows[0];
  expect(row.label).toBe("Synthetic item");
  expect(row.id).not.toContain("private-card-id");
  const result = m.args!.actions.get(row.id)!();
  expect(m.open).not.toHaveBeenCalled();
  await act(async () => { release(true); await result; });
  expect(m.open).toHaveBeenCalledWith(expect.objectContaining({ id: "private-card-id" }));
});

it("does not open stale or unretired details", async () => {
  m.retire.mockResolvedValue(false);
  render(<NativeRecentMemory />);
  let row = m.args!.content.sections[0].rows[0];
  await act(async () => { await m.args!.actions.get(row.id)!(); });
  expect(m.open).not.toHaveBeenCalled();
  m.retire.mockImplementation(async () => { m.epoch++; return true; });
  row = m.args!.content.sections[0].rows[0];
  await act(async () => { await m.args!.actions.get(row.id)!(); });
  expect(m.open).not.toHaveBeenCalled();
});

it("does not open a card after the same account gets a new presentation session", async () => {
  let release!: (value: boolean) => void;
  m.retire.mockReturnValue(new Promise(resolve => { release = resolve; }));
  m.model = { ...m.model, presentationIdentity: Symbol("old-unlock") };
  const view = render(<NativeRecentMemory />);
  const action = m.args!.actions.get(m.args!.content.sections[0].rows[0].id)!();
  m.model = { ...m.model, presentationIdentity: Symbol("new-unlock") };
  view.rerender(<NativeRecentMemory />);
  await act(async () => { release(true); await action; });
  expect(m.open).not.toHaveBeenCalled();
});

it("preserves the full React fallback and never exposes it during a retained native lifetime", () => {
  m.phase = "web"; m.held = true; m.reason = "unsupported";
  const view = render(<NativeRecentMemory />);
  expect(screen.queryByText("Complete React detail")).toBeNull();
  m.held = false;
  view.rerender(<NativeRecentMemory />);
  expect(screen.getByText("Complete React detail")).toBeTruthy();
});

it("keeps React ownership without constructing native handles when the renderer flag is off", () => {
  m.phase = "web"; m.requested = false;
  const uuid = vi.spyOn(crypto, "randomUUID");
  render(<NativeRecentMemory />);
  expect(screen.getByText("Complete React detail")).toBeTruthy();
  expect(uuid).not.toHaveBeenCalled();
  uuid.mockRestore();
});

it("does not flash the web list while native readmission is pending", () => {
  m.phase = "web"; m.reason = "inactive";
  const view = render(<NativeRecentMemory />);
  expect(screen.queryByText("Complete React detail")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Opening Memory…");
  m.reason = "unsupported";
  view.rerender(<NativeRecentMemory />);
  expect(screen.getByText("Complete React detail")).toBeTruthy();
});

it("uses complete React fallback when private rows exceed the native presentation bounds", () => {
  m.phase = "web";
  m.model!.recentMemories = [{ id: "long", title: "x".repeat(4097), value: "" }];
  render(<NativeRecentMemory />);
  expect(m.args?.active).toBe(false);
  expect(screen.getByText("Complete React detail")).toBeTruthy();
});
