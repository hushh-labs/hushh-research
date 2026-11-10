// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validNativeWorkspace, type NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";

const state = vi.hoisted(() => ({ enabled: true, covered: false, held: true, active: false, content: null as unknown, actions: new Map(), apply: vi.fn(), select: vi.fn(), writer: vi.fn(), cancel: vi.fn(), handoff: vi.fn(), mounted: 0, unmounted: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/gmail" }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true }) }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => state.enabled }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeShellOverlayBlocked: () => state.covered }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { phase: state.enabled ? "native" : "web", reason: state.enabled ? "active" : "inactive", held: state.enabled && state.held }, retireForWeb: vi.fn() }),
  useNativeWorkspace: (value: { content: unknown; active: boolean; actions: Map<string, () => unknown> }) => { state.apply(); state.active = value.active; state.content = value.content; state.actions = value.actions; return "native"; },
}));
vi.mock("@/lib/capacitor/use-native-workspace-handoff", () => ({ useNativeWorkspaceHandoff: () => ({ activationRevision: 0, intent: { current: 0 }, handoff: state.handoff }) }));
import { NativeMailRoute, NativeMailReactOnly } from "../native-mail-workspace";

function Saver() { useEffect(() => { state.mounted++; return () => { state.unmounted++; }; }, []); return null; }
function model(): Parameters<typeof NativeMailRoute>[0]["model"] {
  return { owner: "synthetic-owner", onboarding: false, view: "overview", selectView: state.select, connected: true, rootOnly: true, webChild: false,
    root: [{ key: "status", rows: [{ key: "status", label: "Mail connected" }] }] };
}
function projection(): NativeWorkspaceProjection {
  return { documentId: "document", ownerEpoch: "owner", ownerGeneration: 1, revision: 1, updateSequence: 1, privacyGeneration: 0, isolationGeneration: 0,
    appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", canvasHex: "#ffffff",
    frame: { x: 0, y: 100, width: 390, height: 500, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1 },
    ...(state.content as NativeWorkspaceProjection) };
}
beforeEach(() => { vi.clearAllMocks(); state.enabled = true; state.covered = false; state.held = true; state.mounted = 0; state.unmounted = 0; state.content = null; });
describe("Mail presentation contract", () => {
  it("keeps the existing effect-only saver mounted and binds the three authored workspaces", async () => {
    const view = render(<NativeMailRoute model={model()} frame={{ current: null }}><Saver /><p>Complete React Mail</p></NativeMailRoute>);
    const content = projection();
    expect(state.active).toBe(true);
    expect(validNativeWorkspace(content)).toBe(true);
    expect(screen.getByText("Complete React Mail")).not.toBeVisible();
    const kyc = content.tabs!.options.find(option => option.label === "KYC")!;
    await act(async () => { await state.actions.get(kyc.id)!(); });
    expect(state.select).toHaveBeenCalledWith("kyc");
    expect(state.mounted).toBe(1);
    expect(state.unmounted).toBe(0);
    view.unmount();
    expect(state.unmounted).toBe(1);
  });
  it("keeps native confirmation Cancel separate from the existing writer and React portal", async () => {
    render(<NativeMailRoute model={{ ...model(), confirmation: { title: "Disconnect Mail?", description: "Stops Mail access. Saved private memory stays.",
      confirm: { key: "disconnect", label: "Disconnect", run: state.writer }, cancel: state.cancel, cancelLabel: "Keep connected" } }} frame={{ current: null }}>
      <NativeMailReactOnly><p>React confirmation</p></NativeMailReactOnly>
    </NativeMailRoute>);
    const content = projection();
    expect(validNativeWorkspace(content)).toBe(true);
    expect(content.tabs).toBeUndefined();
    expect(screen.queryByText("React confirmation")).toBeNull();
    const cancel = content.sections.flatMap(section => section.rows).find(row => row.label === "Keep connected")!;
    await act(async () => { await state.actions.get(cancel.id)!(); });
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.writer).not.toHaveBeenCalled();
  });
  it("revalidates an authored rich action after retirement instead of running its stale callback", async () => {
    let release!: () => void;
    const retired = new Promise<void>(resolve => { release = resolve; });
    state.handoff.mockImplementation(async (current, valid, open) => { await retired; if (current() && valid()) open(); });
    const initial = { ...model(), root: [{ key: "actions", rows: [{ key: "review", label: "Review", web: true, enabled: true, run: state.writer }] }] };
    const view = render(<NativeMailRoute model={initial} frame={{ current: null }}><p>Complete React Mail</p></NativeMailRoute>);
    const row = projection().sections[0]!.rows[0]!;
    let pending!: Promise<unknown>;
    act(() => { pending = state.actions.get(row.id)!(); });
    view.rerender(<NativeMailRoute model={{ ...initial, root: [{ key: "actions", rows: [{ ...initial.root[0]!.rows[0]!, enabled: false }] }] }} frame={{ current: null }}><p>Complete React Mail</p></NativeMailRoute>);
    await act(async () => { release(); await pending; });
    expect(state.handoff).toHaveBeenCalledOnce();
    expect(state.writer).not.toHaveBeenCalled();
  });
  it("waits for confirmed absence under a temporary DOM overlay and readmits after its token releases", () => {
    const props = { model: model(), frame: { current: null } };
    const view = render(<NativeMailRoute {...props}><p>Complete React Mail</p></NativeMailRoute>);
    state.apply.mockClear();
    state.covered = true;
    view.rerender(<NativeMailRoute {...props}><p>Complete React Mail</p></NativeMailRoute>);
    expect(screen.getByText("Complete React Mail")).not.toBeVisible();
    state.held = false;
    view.rerender(<NativeMailRoute {...props}><p>Complete React Mail</p></NativeMailRoute>);
    expect(screen.getByText("Complete React Mail")).toBeVisible();
    expect(state.apply).not.toHaveBeenCalled();
    state.apply.mockClear();
    state.covered = false;
    view.rerender(<NativeMailRoute {...props}><p>Complete React Mail</p></NativeMailRoute>);
    expect(state.apply).toHaveBeenCalled();
  });
  it("retires before a toggle opens its authored consent review and rejects a changed toggle", async () => {
    let release!: () => void;
    const retired = new Promise<void>(resolve => { release = resolve; });
    state.handoff.mockImplementation(async (current, valid, open) => { await retired; if (current() && valid()) open(); });
    const change = vi.fn();
    const make = (value: boolean) => ({ ...model(), root: [{ key: "settings", rows: [{ key: "approval", label: "Automatic approval", web: true, toggle: { value, change } }] }] });
    const view = render(<NativeMailRoute model={make(false)} frame={{ current: null }}><p>Complete React Mail</p></NativeMailRoute>);
    const option = projection().sections[0]!.rows[0]!.options![0]!;
    let pending!: Promise<unknown>;
    act(() => { pending = state.actions.get(option.id)!(); });
    expect(change).not.toHaveBeenCalled();
    view.rerender(<NativeMailRoute model={make(true)} frame={{ current: null }}><p>Complete React Mail</p></NativeMailRoute>);
    await act(async () => { release(); await pending; });
    expect(state.handoff).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
  });
  it("maps the workspace toggle to Swift's On/Off positions and the existing boolean callback", async () => {
    const change = vi.fn();
    const make = (value: boolean) => ({ ...model(), root: [{ key: "settings", rows: [{ key: "prepare", label: "Prepare automatically", toggle: { value, change } }] }] });
    const view = render(<NativeMailRoute model={make(true)} frame={{ current: null }}>Complete React Mail</NativeMailRoute>);
    const first = projection().sections[0]!.rows[0]!;
    expect(validNativeWorkspace(projection())).toBe(true);
    expect(first.options!.map(option => [option.label, option.selected])).toEqual([["On", true], ["Off", false]]);
    await act(async () => { await state.actions.get(first.options![1].id)!(); });
    expect(change).toHaveBeenLastCalledWith(false);
    view.rerender(<NativeMailRoute model={make(false)} frame={{ current: null }}>Complete React Mail</NativeMailRoute>);
    const second = projection().sections[0]!.rows[0]!;
    await act(async () => { await state.actions.get(second.options![0].id)!(); });
    expect(change).toHaveBeenLastCalledWith(true);
  });
  it("keeps finite choices opaque and makes selected or disabled choices inert", async () => {
    const select = vi.fn();
    const make = (enabled: boolean) => ({ ...model(), root: [{ key: "sources", rows: [{ key: "source", label: "Source", enabled, choices: [
      { key: "private-statement-id", label: "Statement", selected: true, run: () => select("statement") },
      { key: "private-bank-id", label: "Brokerage", selected: false, run: () => select("plaid") },
    ] }] }] });
    const view = render(<NativeMailRoute model={make(true)} frame={{ current: null }}>Complete React Mail</NativeMailRoute>);
    const content = projection(), options = content.sections[0]!.rows[0]!.options!;
    expect(validNativeWorkspace(content)).toBe(true);
    expect(JSON.stringify(content)).not.toContain("private-statement-id");
    await act(async () => { await state.actions.get(options[0].id)!(); });
    expect(select).not.toHaveBeenCalled();
    await act(async () => { await state.actions.get(options[1].id)!(); });
    expect(select).toHaveBeenCalledExactlyOnceWith("plaid");
    view.rerender(<NativeMailRoute model={make(false)} frame={{ current: null }}>Complete React Mail</NativeMailRoute>);
    await act(async () => { await state.actions.get(options[1].id)!(); });
    expect(select).toHaveBeenCalledTimes(1);
    expect(validNativeWorkspace({ ...content, sections: [{ ...content.sections[0], rows: [{ ...content.sections[0]!.rows[0], options: options.map(option => ({ ...option, selected: true })) }] }] })).toBe(false);
    expect(validNativeWorkspace({ ...content, sections: [{ ...content.sections[0], rows: [{ ...content.sections[0]!.rows[0], options: options.map(option => ({ ...option, url: "https://invalid.example" })) }] }] })).toBe(false);
  });
  it("retains the complete React surface with the renderer disabled", () => {
    state.enabled = false;
    render(<NativeMailRoute model={model()} frame={{ current: null }}><p>Complete React Mail</p><NativeMailReactOnly><p>React confirmation</p></NativeMailReactOnly></NativeMailRoute>);
    expect(screen.getByText("Complete React Mail")).toBeVisible();
    expect(screen.getByText("React confirmation")).toBeVisible();
    expect(state.apply).not.toHaveBeenCalled();
  });
});
