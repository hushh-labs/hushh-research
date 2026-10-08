import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NativeChromeLease, chromeOwnerEpoch, canResumeNativeChrome, suspendOwnedNativeChrome, getNativeChromeCapabilities, peekNativeChromeCapabilities, hasOutstandingNativeChrome, retireNativeChrome, retireOwnedNativeChrome, syncNativeCanvasAppearance, type ChromeAcknowledgement, type ChromeProjection, type ChromeUpdateAcknowledgement } from "@/lib/capacitor/native-chrome";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { NativeChatChrome, NativeHistoryClose, NativeHistoryOpener, type NativeChatChromeHandle } from "@/components/app-ui/native-chat-chrome";
import { ProfilePane } from "@/components/app-ui/profile-pane";
import { useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { writeAccent } from "@/lib/theme/accent";
import { isCurrentNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { DockEventFence, type DockEvent, type DockState } from "@/lib/capacitor/native-dock";
import { NativeAgentDock } from "@/components/agent/native-agent-dock";
import { AgentDockProvider, useAgentDockState } from "@/components/agent/agent-dock";
import { useNativeDockPort, useNativeDockPorts, type NativeDockPort } from "@/components/agent/native-dock-port";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "dock-reviewer" } }) }));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
const profile = vi.hoisted(() => ({ query: "profile_pane=1", unlocked: true, pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => profile.pathname, useSearchParams: () => new URLSearchParams(profile.query) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: profile.unlocked }) }));
vi.mock("@/components/profile/profile-workspace-page", () => ({ ProfilePage: () => null }));

const bridge = vi.hoisted(() => ({ platform: "ios", documentId: "document-a", callbacks: new Map<string, (event: unknown) => void>(),
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  subscribe: vi.fn(), prepare: vi.fn(), prepareBackReplacement: vi.fn(), prepareHistoryReplacement: vi.fn(), activate: vi.fn(), update: vi.fn(), suspend: vi.fn(), retire: vi.fn(), restoreFocus: vi.fn(), confirmChoice: vi.fn(), getCapabilities: vi.fn(), setCanvasAppearance: vi.fn() }));
const dockBridge = vi.hoisted(() => ({ callbacks: new Map<string, (event: unknown) => void>(),
  getCapabilities: vi.fn(), apply: vi.fn(), retire: vi.fn(), suspend: vi.fn(), consumeDraft: vi.fn(), beginEditingTransition: vi.fn(), confirmEvent: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: (plugin: string) => plugin === "HushhNativeDock" ? { ...dockBridge,
    addListener: async (name: string, callback: (event: unknown) => void) => {
      dockBridge.callbacks.set(name, callback);
      return { remove: async () => { if (dockBridge.callbacks.get(name) === callback) dockBridge.callbacks.delete(name); } };
    },
  } : ({ ...bridge, addListener: async (name: string, callback: (event: unknown) => void) => {
    await bridge.subscribe(name);
    const listeners = bridge.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    bridge.listeners.set(name, listeners);
    bridge.callbacks.set(name, (event) => listeners.forEach((listener) => listener(event)));
    return { remove: async () => { listeners.delete(callback); if (!listeners.size) bridge.callbacks.delete(name); } };
  } }),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativeDocumentId: () => bridge.documentId,
  getNativeSessionPrivacyState: async () => ({ generation: 0, shielded: false, appIsActive: true }),
  subscribeNativeSessionPrivacy: async () => ({ remove: async () => undefined }) }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ useVoiceSurfaceMetadata: () => null, getVoiceSurfaceMetadata: () => null }));
const projection = { kind: "back" as const, label: "Go back", enabled: true,
  appearance: "light" as const, accentHex: "#112233", foregroundHex: "#223344",
  frame: { x: 2, y: 60, width: 44, height: 44 }, viewport: { width: 390, height: 844 } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
function choice(lease: NativeChromeLease, sequence = 1) { return { ...lease.projection, sequence, privacyGeneration: 0 }; }

describe("private dock event boundary", () => {
  const identity = { documentId: "dock-document", ownerEpoch: "dock-owner", revision: 1 };
  const input = (overrides: Partial<DockEvent> = {}): DockEvent => ({
    ...identity, sequence: 1, updateSequence: 1, editRevision: 1, editorRevision: 0, privacyGeneration: 0,
    context: "conversation-a", kind: "edit", text: "Hello 👋", selectionStart: 8, selectionEnd: 8, ...overrides,
  });
  it("consumes ordered private input once and rejects stale owner, conversation and edit revisions", () => {
    const fence = new DockEventFence(identity);
    expect(fence.accept(input(), "conversation-a")).toBe(true);
    expect(fence.accept(input(), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2, ownerEpoch: "older-owner" }), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2 }), "conversation-b")).toBe(false);
    expect(fence.accept(input({ sequence: 2, editorRevision: 1 }), "conversation-a", 2)).toBe(false);
    expect(fence.accept(input({ sequence: 2, editRevision: 0 }), "conversation-a")).toBe(false);
    expect(fence.accept(input({ sequence: 2, kind: "action", action: "send" }), "conversation-a")).toBe(true);
    expect(fence.accept(input({ sequence: 2, kind: "action", action: "send" }), "conversation-a")).toBe(false);
  });
  it("rejects malformed input without consuming a valid subsequent action", () => {
    const fence = new DockEventFence(identity);
    for (const invalid of [input({ sequence: NaN }), input({ text: null as unknown as string }),
      input({ selectionEnd: 100 }), input({ kind: "action", action: "transport-send" as DockEvent["action"] })]) {
      expect(fence.accept(invalid, "conversation-a")).toBe(false);
    }
    expect(fence.accept(input({ kind: "action", action: "send" }), "conversation-a")).toBe(true);
  });
  it("accepts equal-height keyboard movement but rejects stale or unbounded layout receipts", () => {
    const fence = new DockEventFence(identity);
    const viewport = { width: 390, height: 844 };
    const layout = { ...identity, updateSequence: 1, layoutSequence: 1, privacyGeneration: 0,
      viewport, frame: { x: 16, y: 700, width: 358, height: 52 } };
    expect(fence.acceptLayout(layout, 1, 0, viewport)).toBe(true);
    const moved = { ...layout, layoutSequence: 2, frame: { ...layout.frame, y: 440 } };
    expect(fence.acceptLayout(moved, 1, 0, viewport)).toBe(true);
    expect(fence.acceptLayout(layout, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3, ownerEpoch: "older-owner" }, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 2, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 1, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3, frame: { ...moved.frame, y: -1 } }, 1, 0, viewport)).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 0, { width: 844, height: 390 })).toBe(false);
    expect(fence.acceptLayout({ ...moved, layoutSequence: 3 }, 1, 0, viewport)).toBe(true);
  });
});

describe("private dock asynchronous submission boundary", () => {
  function Feature({ blocked, onAction }: { blocked: boolean; onAction: NativeDockPort["onAction"] }) {
    const dock = useAgentDockState();
    const host = useRef<HTMLDivElement>(null);
    const owner = useRef(Symbol("test-composer"));
    useNativeNavigationBlocked(blocked);
    useLayoutEffect(() => {
      dock?.setHost(host.current);
      dock?.claim(owner.current, true, false);
    }, [dock]);
    useNativeDockPort("text", { projection: {
      context: "synthetic-conversation", mode: "text", text: "Synthetic draft", placeholder: "Message One",
      expanded: false, editable: true, sendEnabled: true, micEnabled: true, cancelEnabled: false,
      recording: false, recordingReady: false, muted: false, supportsHold: false,
      attachments: [], attachmentRevision: 0, editorRevision: 0,
    }, onAction });
    return <div data-agent-bar-shell><div ref={host}><div data-agent-dock-embedded /></div><NativeAgentDock enabled /><PresentationProbe /></div>;
  }
  function PresentationProbe() {
    const ports = useNativeDockPorts();
    return <span data-testid="dock-presentation">{ports?.owned ? "reserved" : "fallback"}</span>;
  }
  function fixture(blocked: boolean, onAction: NativeDockPort["onAction"]) {
    return <AgentDockProvider><Feature blocked={blocked} onAction={onAction} /></AgentDockProvider>;
  }
  function send(state: DockState): DockEvent {
    return { ...state, sequence: 1, editRevision: 0, privacyGeneration: 0, kind: "action", action: "send",
      selectionStart: 0, selectionEnd: 0 };
  }
  beforeEach(() => {
    bridge.platform = "ios"; bridge.documentId = crypto.randomUUID();
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    document.documentElement.classList.remove("dark");
    dockBridge.callbacks.clear();
    dockBridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 1, supported: true });
    dockBridge.apply.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "active" }));
    dockBridge.suspend.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "active" }));
    dockBridge.retire.mockReset().mockImplementation(async state => ({ ...state, height: 52, phase: "retired",
      recovery: { text: "", context: "synthetic-conversation", editorRevision: 0, consumed: true } }));
    dockBridge.confirmEvent.mockReset().mockResolvedValue({ valid: true });
    dockBridge.consumeDraft.mockReset();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 700, width: 350, height: 52,
      top: 700, bottom: 752, left: 20, right: 370, toJSON: () => ({}) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("reserves the cold dock before discovery and restores an unsupported wrapper without creating a native editor", async () => {
    const receipt = deferred<{ contractVersion: number; supported: boolean }>();
    dockBridge.getCapabilities.mockReturnValueOnce(receipt.promise);
    const view = render(fixture(false, vi.fn()));
    expect(view.getByTestId("dock-presentation").textContent).toBe("reserved");
    expect(dockBridge.apply).not.toHaveBeenCalled();
    await act(async () => receipt.resolve({ contractVersion: 1, supported: false }));
    await waitFor(() => expect(view.getByTestId("dock-presentation").textContent).toBe("fallback"));
    view.rerender(fixture(true, vi.fn()));
    expect(view.getByTestId("dock-presentation").textContent).toBe("fallback");
    expect(dockBridge.apply).not.toHaveBeenCalled();
  });
  it("retires a consumed replica when an overlay invalidates its delayed receipt, without sending or replaying", async () => {
    const onAction = vi.fn();
    const receipt = deferred<{ consumed: boolean; editRevision: number }>();
    dockBridge.consumeDraft.mockReturnValue(receipt.promise);
    const view = render(fixture(false, onAction));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    act(() => dockBridge.callbacks.get("input")?.(send(initial)));
    await waitFor(() => expect(dockBridge.consumeDraft).toHaveBeenCalledOnce());
    view.rerender(fixture(true, onAction));
    await act(async () => { receipt.resolve({ consumed: true, editRevision: 1 }); });
    await waitFor(() => expect(dockBridge.retire).toHaveBeenCalledWith(expect.objectContaining({ revision: initial.revision, preserveDraft: true })));
    expect(onAction).not.toHaveBeenCalled();
    view.rerender(fixture(false, onAction));
    await waitFor(() => expect((dockBridge.apply.mock.calls.at(-1)![0] as DockState).revision).toBeGreaterThan(initial.revision));
    expect(onAction).not.toHaveBeenCalled();
  });
  it("keeps consumption unsettled until the feature guard finishes and consumes duplicate Send only once", async () => {
    const guard = deferred<void>();
    const onAction = vi.fn(() => guard.promise);
    dockBridge.consumeDraft.mockResolvedValue({ consumed: true, editRevision: 1 });
    render(fixture(false, onAction));
    await waitFor(() => expect(dockBridge.apply).toHaveBeenCalled());
    const initial = dockBridge.apply.mock.calls.at(-1)![0] as DockState;
    const request = send(initial);
    act(() => { dockBridge.callbacks.get("input")?.(request); dockBridge.callbacks.get("input")?.(request); });
    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(dockBridge.apply.mock.calls.every(([state]) => state.settledConsumption === 0)).toBe(true);
    await act(async () => { guard.resolve(); });
    await waitFor(() => expect(dockBridge.apply.mock.calls.some(([state]) => state.settledConsumption === 1)).toBe(true));
    expect(onAction).toHaveBeenCalledOnce();
    expect(dockBridge.consumeDraft).toHaveBeenCalledOnce();
  });
});

describe("native chrome presentation lease", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.style.removeProperty("--app-accent");
    document.documentElement.style.removeProperty("--app-accent-deep");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    document.documentElement.style.removeProperty("--background");
    bridge.platform = "ios";
    profile.query = "profile_pane=1"; profile.unlocked = true; profile.pathname = "/";
    bridge.documentId = crypto.randomUUID();
    bridge.callbacks.clear();
    bridge.listeners.clear();
    bridge.subscribe.mockReset().mockResolvedValue(undefined);
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true });
    bridge.setCanvasAppearance.mockReset().mockImplementation(async (value) => value);
    bridge.prepare.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.prepareBackReplacement.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.prepareHistoryReplacement.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.activate.mockReset().mockImplementation(async (value) => ({ ...value, phase: "active" }));
    bridge.update.mockReset().mockImplementation(async (value) => value);
    bridge.restoreFocus.mockReset().mockImplementation(async (value) => ({ ...value, restored: true }));
    bridge.retire.mockReset().mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    bridge.suspend.mockReset().mockImplementation(async (value) => ({ ...value, phase: "suspended" }));
    bridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    await Promise.all(["top-shell-back", "profile-back", "chat-history-toggle", "chat-agent-surface", "profile-close", "stationary-more", "bounded-selection", "bounded-date", "profile-appearance", "profile-accent"].map((controlId) =>
      retireNativeChrome("owner-a", undefined, controlId as ChromeProjection["controlId"])));
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("requires acknowledged suspension and identical ownership/schema/geometry before resuming a host with fresh authority", async () => {
    const epoch = chromeOwnerEpoch("account-a", "top-shell-back");
    expect(chromeOwnerEpoch("account-a", "top-shell-back")).toBe(epoch);
    const old = new NativeChromeLease(projection, epoch);
    await old.prepare(); await old.activate();
    const receipt = deferred<ChromeAcknowledgement>();
    bridge.suspend.mockReturnValueOnce(receipt.promise);
    const suspension = suspendOwnedNativeChrome(old);
    const resume = canResumeNativeChrome(projection, epoch);
    const invoke = vi.fn();
    await old.choose(choice(old), () => true, invoke);
    expect(invoke).not.toHaveBeenCalled();
    receipt.resolve({ ...old.projection, phase: "suspended" });
    await suspension;
    expect(await resume).toBe(true);
    expect(await canResumeNativeChrome({ ...projection, frame: { ...projection.frame, x: 3 } }, epoch)).toBe(false);
    expect(await canResumeNativeChrome({ ...projection, label: "Another action" }, epoch)).toBe(false);
    expect(await canResumeNativeChrome(projection, chromeOwnerEpoch("account-b", "top-shell-back"))).toBe(false);
    const next = new NativeChromeLease(projection, epoch);
    await next.prepare(); await next.activate();
    await retireOwnedNativeChrome(old.projection);
    expect(next.ownsInstallation).toBe(true);
    await next.choose(choice(old), () => true, invoke);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not resume an uncertain suspension or release its concealed slot before retirement", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    await lease.prepare(); await lease.activate();
    bridge.suspend.mockResolvedValueOnce({ ...lease.projection, phase: "retired" });
    await expect(suspendOwnedNativeChrome(lease)).rejects.toThrow("NATIVE_CHROME_SUSPEND_UNCONFIRMED");
    expect(await canResumeNativeChrome(projection, "owner-a")).toBe(false);
    expect(hasOutstandingNativeChrome()).toBe(true);
    await retireOwnedNativeChrome(lease.projection);
    expect(hasOutstandingNativeChrome()).toBe(false);
  });
  it("discovers immutable wrapper capabilities once per document, not per control or route", async () => {
    const capability = deferred<{ contractVersion: number; families: "back"[]; independentControls: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(capability.promise);
    const first = getNativeChromeCapabilities(), second = getNativeChromeCapabilities();
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
    capability.resolve({ contractVersion: 2, families: ["back"], independentControls: true });
    expect(await first).toBe(await second);
    expect(await getNativeChromeCapabilities()).toBe(peekNativeChromeCapabilities());
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
    bridge.documentId = crypto.randomUUID();
    expect(peekNativeChromeCapabilities()).toBeUndefined();
    await getNativeChromeCapabilities();
    expect(bridge.getCapabilities).toHaveBeenCalledTimes(2);
    bridge.platform = "android";
    expect(await getNativeChromeCapabilities()).toBeNull();
    expect(peekNativeChromeCapabilities()).toBeUndefined();
  });
  it("uses the committed CSS canvas and cannot repaint an older theme after delayed discovery", async () => {
    const discovery = deferred<{ contractVersion: number; families: "back"[]; canvasAppearance: boolean }>();
    const capability = { contractVersion: 2, families: [] as "back"[], canvasAppearance: true };
    document.documentElement.style.setProperty("--background", "#f2f2f7");
    bridge.getCapabilities.mockReturnValueOnce(discovery.promise).mockResolvedValue(capability);
    const old = syncNativeCanvasAppearance();
    document.documentElement.style.setProperty("--background", "#0e0e10");
    const latest = syncNativeCanvasAppearance();
    discovery.resolve(capability);
    expect(await latest).toBe(true);
    expect(await old).toBe(false);
    expect(bridge.setCanvasAppearance).toHaveBeenCalledOnce();
    expect(bridge.setCanvasAppearance.mock.calls[0][0]).toMatchObject({ documentId: bridge.documentId, backgroundHex: "#0e0e10" });
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    expect(await syncNativeCanvasAppearance()).toBe(false);
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue(capability);
    bridge.setCanvasAppearance.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1 }));
    await expect(syncNativeCanvasAppearance()).rejects.toThrow("NATIVE_CANVAS_ACK_UNCONFIRMED");
  });
  it("does not transfer interaction before matching layout and activation acknowledgements", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const action = vi.fn();
    await lease.prepare();
    await lease.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
    await lease.activate();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
  });
  it("fences choices across reordered in-place snapshots without replacing the lease", async () => {
    const lease = new NativeChromeLease(projection, "owner-a", "context", true);
    await lease.prepare(); await lease.activate();
    const first = deferred<ChromeUpdateAcknowledgement>();
    const second = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const action = vi.fn();
    const older = lease.update({ ...projection, accentHex: "#334455", enabled: true });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const newer = lease.update({ ...projection, accentHex: "#556677", enabled: true });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledTimes(2));
    await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action);
    expect(action).not.toHaveBeenCalled();
    second.resolve(bridge.update.mock.calls[1][0]); expect(await newer).toBe(true);
    first.resolve(bridge.update.mock.calls[0][0]); expect(await older).toBe(false);
    expect(lease.projection.accentHex).toBe("#556677");
    await lease.choose({ ...choice(lease), updateSequence: 1 }, () => true, action);
    expect(action).not.toHaveBeenCalled();
    await lease.choose({ ...choice(lease), updateSequence: 2 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    await lease.update({ ...projection, enabled: false });
    await lease.choose({ ...choice(lease, 2), updateSequence: 3 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.activate).toHaveBeenCalledOnce();
  });
  it("does not fence an identical acknowledged presentation but never coalesces across a pending change", async () => {
    const lease = new NativeChromeLease(projection, "owner-a", "context", true);
    await lease.prepare();
    const activation = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(activation.promise);
    const original = { appearance: projection.appearance, accentHex: projection.accentHex,
      foregroundHex: projection.foregroundHex, enabled: true };
    const activating = lease.activate();
    const unchangedDuringActivation = lease.update(original);
    const action = vi.fn();
    await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action);
    expect(action).not.toHaveBeenCalled();
    activation.resolve({ ...lease.projection, phase: "active" });
    await activating;
    expect(await unchangedDuringActivation).toBe(true);
    expect(bridge.update).not.toHaveBeenCalled();
    await lease.choose({ ...choice(lease), updateSequence: 0 }, () => true, action);
    expect(action).toHaveBeenCalledOnce();
    const pending = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(pending.promise);
    const changing = lease.update({ ...original, accentHex: "#334455" });
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const reverting = lease.update(original);
    await waitFor(() => expect(bridge.update).toHaveBeenCalledTimes(2));
    expect(await reverting).toBe(true);
    pending.resolve(bridge.update.mock.calls[0][0]);
    expect(await changing).toBe(false);
    expect(lease.projection.accentHex).toBe(original.accentHex);
    expect(await lease.update(original)).toBe(true);
    expect(bridge.update).toHaveBeenCalledTimes(2);
    lease.invalidate();
    expect(await lease.update(original)).toBe(false);
  });
  it("keeps an uncertain presentation quarantined until exact retirement is confirmed", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, frame: { ...projection.frame, x: 99 }, phase: "prepared" }));
    await expect(lease.prepare()).rejects.toThrow("LAYOUT_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1, phase: "retired" }));
    await expect(retireNativeChrome("owner-a")).rejects.toThrow("RETIRE_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    await retireNativeChrome("owner-a");
    expect(hasOutstandingNativeChrome()).toBe(false);
  });
  it.each(["owner", "context", "privacy", "disabled"])("rejects %s changes while a choice is being confirmed", async (reason) => {
    const lease = new NativeChromeLease({ ...projection, enabled: reason !== "disabled" }, "owner-a");
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValue(pending.promise);
    const action = vi.fn();
    let allowed = true;
    await lease.prepare(); await lease.activate();
    const result = lease.choose(choice(lease), () => allowed, action);
    if (reason === "owner") lease.invalidate(); else allowed = false;
    pending.resolve({ valid: true }); await result;
    expect(action).not.toHaveBeenCalled();
  });
  it("does not activate a retired preparation or accept another owner/revision", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const pending = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(pending.promise);
    const preparing = lease.prepare(); lease.invalidate();
    pending.resolve({ ...lease.projection, phase: "prepared" });
    expect(await preparing).toBe(false);
    await lease.activate(); expect(bridge.activate).not.toHaveBeenCalled();
    const fresh = new NativeChromeLease(projection, "owner-b");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, phase: "prepared" }));
    await fresh.prepare(); await fresh.activate();
    const action = vi.fn();
    await fresh.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
  });
  it("never lets late recovery retire a replacement or reordered confirmations execute twice", async () => {
    const old = new NativeChromeLease(projection, "owner-a");
    await old.prepare(); await old.activate();
    const fresh = new NativeChromeLease(projection, "owner-b");
    await fresh.prepare(); await fresh.activate();
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", old.projection);
    expect(bridge.retire).not.toHaveBeenCalled();
    const first = deferred<{ valid: boolean }>();
    const second = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const action = vi.fn();
    const firstChoice = fresh.choose(choice(fresh, 1), () => true, action);
    const secondChoice = fresh.choose(choice(fresh, 2), () => true, action);
    second.resolve({ valid: true }); await secondChoice;
    first.resolve({ valid: true }); await firstChoice;
    expect(action).toHaveBeenCalledOnce();
    await fresh.choose(choice(fresh, 3), () => true, action);
    // A new intentional tap remains available if navigation was cancelled.
    // It is not a replay of either previously consumed choice.
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("retires only the requested independent control, including delayed acknowledgement", async () => {
    const back = new NativeChromeLease(projection, "owner-a");
    const history = new NativeChromeLease({ ...projection, kind: "history", label: "Open chat history" }, "owner-a");
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, x: 100, width: 100 } }, "owner-a");
    for (const lease of [back, history, selector]) { await lease.prepare(); await lease.activate(); }
    expect([back, history, selector].map((lease) => hasOutstandingNativeChrome(lease.projection.controlId))).toEqual([true, true, true]);
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    history.invalidate();
    const retirement = retireNativeChrome("owner-a", history.projection);
    const request = bridge.retire.mock.calls.at(-1)![0];
    const replacement = new NativeChromeLease({ ...projection, kind: "history" }, "owner-b");
    await replacement.prepare(); await replacement.activate();
    retired.resolve({ ...request, phase: "retired" }); await retirement;
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(true);
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", history.projection);
    await retireNativeChrome("owner-a", back.projection, "chat-agent-surface");
    expect(bridge.retire).not.toHaveBeenCalled();
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    await back.choose(choice(back), () => true, actions[0]);
    await selector.choose({ ...choice(selector), value: "puppy" }, () => true, actions[1]);
    await replacement.choose(choice(replacement), () => true, actions[2]);
    actions.forEach((action) => expect(action).toHaveBeenCalledOnce());
    await retireNativeChrome("owner-b", replacement.projection);
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome()).toBe(true);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
  });

  it("rejects stale selector identities and unbounded values before native confirmation", async () => {
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, width: 100 } }, "owner-a");
    await selector.prepare(); await selector.activate();
    const action = vi.fn();
    const event = { ...choice(selector), value: "puppy" as const };
    for (const invalid of [
      { ...event, ownerEpoch: "other-owner" }, { ...event, revision: event.revision - 1 },
      { ...event, controlId: "chat-history-toggle" as const }, { ...event, documentId: "other-document" },
      { ...event, value: "unbounded" as "one" }, { ...event, value: undefined },
    ]) await selector.choose(invalid, () => true, action);
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    await selector.choose(event, () => true, action);
    expect(bridge.confirmChoice).toHaveBeenCalledWith(expect.objectContaining({ controlId: "chat-agent-surface", value: "puppy" }));
    expect(action).toHaveBeenCalledOnce();
  });

  function ChatHarness({ kind = "history", value = "one", pendingAttention = 0, owner = "synthetic-owner",
    context = "/one/chat:vault-epoch", onAction = vi.fn(), handle, suppressed = false, eligible = true }: {
    kind?: "history" | "agent-surface"; value?: "one" | "puppy"; pendingAttention?: number;
    owner?: string; context?: string; onAction?: (value?: "one" | "puppy") => void;
    handle?: ReturnType<typeof createRef<NativeChatChromeHandle>>;
    suppressed?: boolean; eligible?: boolean;
  }) {
    useSessionChromeSuppression(suppressed);
    const focusRef = useRef<HTMLButtonElement>(null);
    const common = { owner, context, eligible, className: "chat-slot", focusRef, ref: handle };
    const fallback = <button ref={focusRef}>Authored {kind}</button>;
    return kind === "history"
      ? <NativeChatChrome {...common} kind="history" pendingAttention={pendingAttention} onActivate={onAction}>{fallback}</NativeChatChrome>
      : <NativeChatChrome {...common} kind="agent-surface" value={value} onValueChange={onAction}>{fallback}</NativeChatChrome>;
  }
  function admitChat() {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back", "history", "agent-surface"], independentControls: true });
  }
  it.each([true, false])("does not paint a cold web control before native capability discovery (supported=%s)", async (supported) => {
    measureSlot();
    const receipt = deferred<{ contractVersion: number; families: readonly string[]; independentControls: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(receipt.promise);
    const view = render(<ChatHarness />);
    expect(view.getByText("Authored history")).not.toBeVisible();
    expect(bridge.activate).not.toHaveBeenCalled();
    await act(async () => receipt.resolve({ contractVersion: 2, families: supported ? ["history"] : [], independentControls: true }));
    if (supported) {
      await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
      expect(view.getByText("Authored history")).not.toBeVisible();
    } else {
      await waitFor(() => expect(view.getByText("Authored history")).toBeVisible());
      expect(bridge.prepare).not.toHaveBeenCalled();
    }
  });
  it("reopens an admitted History slot without hard removal or a visible web duplicate", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"],
      independentControls: true, inPlaceUpdates: true, retainedControls: true });
    await getNativeChromeCapabilities(); measureSlot();
    const view = render(<ChatHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const first = bridge.prepare.mock.calls.at(-1)![0];
    const removals = bridge.retire.mock.calls.length;
    view.rerender(<ChatHarness eligible={false} />);
    await waitFor(() => expect(bridge.suspend).toHaveBeenCalledOnce());
    expect(view.getByText("Authored history")).not.toBeVisible();
    view.rerender(<ChatHarness eligible />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls.at(-1)![0].ownerEpoch).toBe(first.ownerEpoch);
    expect(bridge.prepare.mock.calls.at(-1)![0].revision).toBeGreaterThan(first.revision);
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(view.getByText("Authored history")).not.toBeVisible();
  });
  it("does not flash its web replacement between native retirement and the next preparation", async () => {
    admitChat();
    await getNativeChromeCapabilities(); // App-wide bootstrap, before this route mounts.
    let x = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x, y: 60, width: 44, height: 44, top: 60, left: x, right: x + 44, bottom: 104, toJSON: () => ({}),
    }));
    const preparing = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(preparing.promise);
    const view = render(<ChatHarness />);
    const fallback = view.getByText("Authored history");
    expect(fallback).not.toBeVisible();
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledOnce());
    expect(fallback).not.toBeVisible();
    await act(async () => preparing.resolve({ ...bridge.prepare.mock.calls[0][0], phase: "prepared" }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const replacement = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(replacement.promise);
    const retirement = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retirement.promise);
    const removals = bridge.retire.mock.calls.length;
    act(() => bridge.callbacks.get("invalidated")?.(undefined));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(removals + 1));
    expect(fallback).not.toBeVisible();
    x = 3; // DOM-only movement during retirement, without a resize notification.
    await act(async () => retirement.resolve({ ...bridge.retire.mock.calls.at(-1)![0], phase: "retired" }));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls[1][0].frame.x).toBe(3);
    expect(fallback).not.toBeVisible();
    await act(async () => replacement.reject(new Error("NATIVE_CHROME_PREPARE_REFUSED")));
    await waitFor(() => expect(fallback).toBeVisible()); // Only confirmed failure retirement restores it.
    expect(bridge.getCapabilities).toHaveBeenCalledOnce();
  });
  it.each(["back", "history"] as const)("recovers a warm concealed %s slot after listener setup fails", async (kind) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [kind], independentControls: true });
    await getNativeChromeCapabilities();
    bridge.subscribe.mockRejectedValueOnce(new Error("synthetic-subscription-failure"));
    const view = render(kind === "back" ? <Harness /> : <ChatHarness />);
    const fallback = kind === "back" ? view.getByLabelText("Go back") : view.getByText("Authored history");
    expect(fallback).not.toBeVisible();
    await waitFor(() => expect(fallback).toBeVisible());
    expect(bridge.prepare).not.toHaveBeenCalled();
    await waitFor(() => expect([...bridge.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)).toBe(0));
    view.unmount();

    // A failed channel is not authority over a different mounted control.
    measureSlot();
    const subscription = deferred<void>();
    bridge.subscribe.mockReturnValueOnce(subscription.promise);
    const subscriptions = bridge.subscribe.mock.calls.length;
    const oldAction = vi.fn(), currentAction = vi.fn();
    const pending = render(retainedControl(kind, "pending-listener", oldAction));
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(subscriptions + 2));
    const currentView = render(retainedControl(kind, "current-listener", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const removals = bridge.retire.mock.calls.length;
    await act(async () => subscription.reject(new Error("synthetic-subscription-failure")));
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(within(pending.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    pending.unmount();
    currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));
  });
  function PreferenceHarness({ eligible = true, onAppearance = vi.fn(), onAccent = vi.fn() }: {
    eligible?: boolean; onAppearance?: (value: "light" | "dark" | "system") => void; onAccent?: (value: "blue" | "gold") => void;
  }) {
    useNativeNavigationBlocked(true, "profile-pane");
    const appearanceRef = useRef<HTMLButtonElement>(null), accentRef = useRef<HTMLButtonElement>(null);
    const common = { owner: "synthetic-owner", context: "preferences", eligible, className: "preference-slot" };
    return <section data-testid="preference-scroll-root">
      <NativeChatChrome {...common} kind="appearance" value="system" onValueChange={onAppearance} focusRef={appearanceRef}>
        <button ref={appearanceRef}>Appearance fallback</button>
      </NativeChatChrome>
      <NativeChatChrome {...common} kind="accent" value="blue" onValueChange={onAccent} focusRef={accentRef}>
        <button ref={accentRef}>Accent fallback</button>
      </NativeChatChrome>
    </section>;
  }
  it("isolates public preference IDs and retires choices for scrolling, animations and a closed pane", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = appearance ? 2 : 150, width = appearance ? 132 : 44;
      return { x, y: 60, width, height: 44, top: 60, left: x, right: x + width, bottom: 104, toJSON: () => ({}) };
    });
    const onAppearance = vi.fn(), onAccent = vi.fn();
    const view = render(<PreferenceHarness onAppearance={onAppearance} onAccent={onAccent} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const appearance = bridge.prepare.mock.calls.find(([p]) => p.kind === "appearance")![0];
    const accent = bridge.prepare.mock.calls.find(([p]) => p.kind === "accent")![0];
    expect(appearance).toMatchObject({ controlId: "profile-appearance", value: "system" });
    expect(accent).toMatchObject({ controlId: "profile-accent", value: "blue" });
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...appearance, sequence: 1, updateSequence: 0, privacyGeneration: 0, value: "dark" }));
    await waitFor(() => expect(onAppearance).toHaveBeenCalledWith("dark"));
    expect(onAccent).not.toHaveBeenCalled();
    const root = view.getByTestId("preference-scroll-root");
    fireEvent.scroll(root);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...accent, sequence: 1, updateSequence: 0, privacyGeneration: 0, value: "gold" }));
    expect(onAccent).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    const animation = (type: string) => Object.assign(new Event(type, { bubbles: true }), { animationName: "pane-exit" });
    fireEvent(root, animation("animationstart"));
    const preparations = bridge.prepare.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(bridge.prepare).toHaveBeenCalledTimes(preparations); // No 150ms readmission during a 300ms sheet.
    fireEvent(root, animation("animationcancel"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(6));
    const latest = bridge.prepare.mock.calls.at(-1)![0];
    view.rerender(<PreferenceHarness eligible={false} onAppearance={onAppearance} onAccent={onAccent} />);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latest, sequence: 2, updateSequence: 0, privacyGeneration: 0, value: "gold" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Accent fallback" })).toBeVisible());
    expect(onAccent).not.toHaveBeenCalled();
  });
  it.each(["stationary", "transform", "geometry"] as const)("admits %s preference geometry without bypassing initial motion recovery", async (initial) => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
    const keyframeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "KeyframeEffect");
    class TransformEffect { getKeyframes() { return [{ transform: "translateX(10px)" }]; } }
    Object.defineProperty(globalThis, "KeyframeEffect", { configurable: true, value: TransformEffect });
    let moving = initial === "transform", geometryValid = initial !== "geometry";
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => moving
      ? [{ playState: "running", effect: new TransformEffect() }] : [] });
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = appearance ? 2 : 150, width = appearance ? 132 : 44, y = geometryValid ? 60 : -1;
      return { x, y, width, height: 44, top: y, left: x, right: x + width, bottom: y + 44, toJSON: () => ({}) };
    });
    try {
      const view = render(<PreferenceHarness />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      if (initial === "stationary") {
        expect(bridge.activate).toHaveBeenCalledTimes(2); // No 150ms artificial delay.
      } else {
        expect(bridge.prepare).not.toHaveBeenCalled();
        if (initial === "transform") {
          await act(async () => { await vi.advanceTimersByTimeAsync(350); });
          expect(bridge.prepare).not.toHaveBeenCalled(); // A pre-listener transform is still running.
        }
        moving = false; geometryValid = true;
        // No ResizeObserver or start/end notification: the existing settlement
        // owner must recover initially clipped/unmeasurable geometry.
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(bridge.activate).toHaveBeenCalledTimes(2);
      }
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    } finally {
      vi.useRealTimers();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "getAnimations", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
      if (keyframeDescriptor) Object.defineProperty(globalThis, "KeyframeEffect", keyframeDescriptor);
      else Reflect.deleteProperty(globalThis, "KeyframeEffect");
    }
  });
  it("exposes only allowlisted public rehearsal status with explicit Debug capability", async () => {
    const capability = { contractVersion: 2, families: ["agent-surface"], independentControls: true };
    bridge.getCapabilities.mockResolvedValue(capability);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 116, height: 44, top: 60, left: 2, right: 118, bottom: 104, toJSON: () => ({}),
    });
    bridge.prepare.mockRejectedValue(new Error("synthetic-private-response-must-not-appear"));
    const ordinary = render(<ChatHarness kind="agent-surface" />);
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
    expect(ordinary.queryByTestId("native-selector-rehearsal-status")).toBeNull();
    ordinary.unmount();
    bridge.documentId = crypto.randomUUID();
    bridge.getCapabilities.mockResolvedValue({ ...capability, rehearsalDiagnostics: true });
    const rehearsal = render(<ChatHarness kind="agent-surface" />);
    await waitFor(() => expect(rehearsal.getByTestId("native-selector-rehearsal-status")).toHaveTextContent('"outcome":"rejected"'));
    const status = rehearsal.getByTestId("native-selector-rehearsal-status").textContent!;
    expect(status).toContain('"code":"other"');
    expect(status).not.toContain("synthetic-private-response");
    expect(status).not.toContain("synthetic-owner");
    expect(status).not.toContain("document-a");
    expect(status).not.toContain("vault-epoch");
  });
  it.each(["clipped", "inert"])("does not retain unchanged preference frames when their ancestor becomes %s", async (admission) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["appearance", "accent"], independentControls: true, inPlaceUpdates: true });
    let clipped = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parent = this.dataset.testid === "preference-scroll-root";
      const appearance = this.dataset.nativeChromeSlot === "profile-appearance";
      const x = parent || appearance ? 2 : 150, width = parent ? 300 : appearance ? 132 : 44;
      const height = parent && clipped ? 20 : 44;
      return { x, y: 60, width, height, top: 60, left: x, right: x + width, bottom: 60 + height, toJSON: () => ({}) };
    });
    const action = vi.fn();
    const view = render(<PreferenceHarness onAppearance={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const old = bridge.prepare.mock.calls.find(([p]) => p.kind === "appearance")![0];
    const root = view.getByTestId("preference-scroll-root");
    const retirements = bridge.retire.mock.calls.length;
    if (admission === "inert") root.setAttribute("inert", "");
    else { clipped = true; root.style.overflowY = "hidden"; }
    fireEvent(window, new Event("resize"));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, updateSequence: 1, privacyGeneration: 0, value: "dark" }));
    await waitFor(() => expect(bridge.retire.mock.calls.length).toBeGreaterThan(retirements));
    await act(async () => { await Promise.resolve(); });
    expect(action).not.toHaveBeenCalled();
    expect(bridge.prepare).toHaveBeenCalledTimes(2);
  });
  it("updates a mounted selector without reinstalling and rejects choices before the latest ack", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["agent-surface"], independentControls: true, inPlaceUpdates: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 116, height: 44, top: 60, left: 2, right: 118, bottom: 104, toJSON: () => ({}),
    });
    const action = vi.fn();
    const view = render(<ChatHarness kind="agent-surface" value="one" onAction={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    const pending = deferred<ChromeUpdateAcknowledgement>();
    bridge.update.mockReturnValueOnce(pending.promise);
    view.rerender(<ChatHarness kind="agent-surface" value="puppy" onAction={action} />);
    await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    const update = bridge.update.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...update, value: "puppy", sequence: 1, privacyGeneration: 0 }));
    expect(action).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(update); await pending.promise; });
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...update, value: "puppy", sequence: 2, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith("puppy"));
    expect(bridge.prepare).toHaveBeenCalledOnce(); expect(bridge.activate).toHaveBeenCalledOnce();
  });
  it("preserves CSS secondary-label color and alpha, fencing unresolved or changed utility colors", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
    document.documentElement.style.setProperty("--muted-foreground", "oklch(0.6 0.005 264)");
    const view = render(<ChatHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const light = bridge.prepare.mock.calls.at(-1)![0];
    expect(light.foregroundHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(light.foregroundHex).not.toBe(light.accentHex);
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(true);
    // The action check reads committed CSS before observer publication.
    document.documentElement.style.setProperty("--muted-foreground", "rgba(235, 235, 245, 0.72)");
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(false);
    act(() => document.documentElement.classList.add("dark"));
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", foregroundHex: "#ebebf5b8",
    }));
    const dark = bridge.prepare.mock.calls.at(-1)![0];
    document.documentElement.style.setProperty("--muted-foreground", "var(--unresolved-utility)");
    expect(isCurrentNativeControlAppearance(dark, "secondary")).toBe(false);
    act(() => document.documentElement.setAttribute("data-accent", "gold"));
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
  });
  it("isolates simultaneous authored controls and retires native history when attention appears", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const selector = this.textContent?.includes("agent-surface");
      return { x: selector ? 100 : 2, y: 60, width: selector ? 100 : 44, height: 44,
        top: 60, left: selector ? 100 : 2, right: selector ? 200 : 46, bottom: 104, toJSON: () => ({}) };
    });
    const onAction = vi.fn();
    const view = render(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    bridge.activate.mockImplementation(async (identity) => {
      const kind = identity.controlId === "chat-history-toggle" ? "history" : "agent-surface";
      const button = view.getByText(`Authored ${kind}`);
      expect(button.parentElement).toHaveAttribute("inert");
      expect(button.parentElement).toHaveAttribute("aria-hidden", "true");
      expect(button.parentElement).toHaveStyle({ visibility: "hidden" });
      return { ...identity, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "history")![0].foregroundHex).toBe("#8e8e93");
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "agent-surface")![0].foregroundHex).not.toBe("#8e8e93");
    const old = bridge.activate.mock.calls.find(([identity]) => identity.controlId === "chat-history-toggle")![0];
    const confirmation = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(confirmation.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    view.rerender(<><ChatHarness pendingAttention={1} onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await act(async () => { confirmation.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
    expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(1);
    view.rerender(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await waitFor(() => expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(2));
  });
  it.each([84, 88, 100, 321])("measures the selector's authored %s-point width instead of guessing a header size", async (width) => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width, height: 44, top: 60, left: 100, right: 100 + width, bottom: 104, toJSON: () => ({}),
    });
    const view = render(<ChatHarness kind="agent-surface" />);
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    if (width >= 88 && width <= 320) {
      await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-surface", value: "one", frame: expect.objectContaining({ width }) })));
    } else {
      expect(bridge.prepare).not.toHaveBeenCalled();
      expect(view.getByRole("button", { name: "Authored agent-surface" })).toBeVisible();
    }
  });
  it("keeps selection React-owned and rejects an old owner/value during confirmation", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width: 100, height: 44, top: 60, left: 100, right: 200, bottom: 104, toJSON: () => ({}),
    });
    const onAction = vi.fn();
    const view = render(<ChatHarness kind="agent-surface" onAction={onAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.activate.mock.calls.at(-1)![0];
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(pending.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, value: "puppy", sequence: 1, privacyGeneration: 0 }));
    view.rerender(<ChatHarness kind="agent-surface" owner="replacement-owner" value="puppy" onAction={onAction} />);
    await act(async () => { pending.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const fresh = bridge.activate.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...fresh, value: "one", sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("one"));
    expect(bridge.prepare.mock.calls.at(-1)![0].value).toBe("puppy"); // No second selector state.
  });
  it("restores authored focus only after native retirement and holds fallback until blur", async () => {
    admitChat(); measureSlot();
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    const firstRetirement = bridge.retire.mock.calls.length;
    let result!: Promise<boolean>;
    act(() => { result = handle.current!.restoreFocus(); });
    const identity = bridge.retire.mock.calls[firstRetirement][0];
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    await act(async () => { retired.resolve({ ...identity, phase: "retired" }); expect(await result).toBe(true); });
    const button = view.getByRole("button", { name: "Authored history" });
    await waitFor(() => expect(button).toHaveFocus());
    const preparations = bridge.prepare.mock.calls.length;
    fireEvent(window, new Event("resize"));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).toHaveBeenCalledTimes(preparations);
    act(() => { button.blur(); });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
  });

  it("does not latch an untransferred focus hold after rejected retirement", async () => {
    admitChat(); measureSlot();
    const handle = createRef<NativeChatChromeHandle>();
    const action = vi.fn();
    const view = render(<ChatHarness handle={handle} onAction={action} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const preparations = bridge.prepare.mock.calls.length;
    bridge.retire.mockRejectedValueOnce(new Error("NATIVE_CHROME_ACK_UNCERTAIN"));
    await act(async () => { expect(await handle.current!.restoreFocus()).toBe(false); });
    // Recovery may confirm retirement, not replay the authored operation or
    // focus a control beneath an uncertain native presentation.
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
    expect(action).not.toHaveBeenCalled();
    expect(view.getByText("Authored history")).not.toHaveFocus();
    await waitFor(() => expect(view.getByText("Authored history").parentElement).toHaveAttribute("inert"));
  });

  it("returns native History focus without latching DOM fallback and rejects stale owner focus", async () => {
    admitChat(); measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true,
      inPlaceUpdates: true, focusReturn: true });
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const lifecycle = [bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length];
    let result!: Promise<boolean>;
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledOnce());
    expect(await result).toBe(true);
    expect([bridge.retire.mock.calls.length, bridge.prepare.mock.calls.length, bridge.activate.mock.calls.length]).toEqual(lifecycle);
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    expect(bridge.restoreFocus.mock.calls[0][0]).toMatchObject({
      controlId: "chat-history-toggle", updateSequence: 0, focusSequence: 1,
    });
    const pending = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(pending.promise);
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledTimes(2));
    const old = bridge.restoreFocus.mock.calls.at(-1)![0];
    view.rerender(<ChatHarness handle={handle} owner="replacement-owner" />);
    await act(async () => { pending.resolve({ ...old, restored: true }); });
    expect(await result).toBe(false);
    expect(view.getByText("Authored history")).not.toHaveFocus();
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)?.[0].ownerEpoch).not.toBe(old.ownerEpoch));
    const preparations = bridge.prepare.mock.calls.length;
    const preparation = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValueOnce(preparation.promise);
    // A moved slot cannot take the retained-focus path, even before resize
    // notification. Keep failed-preparation recovery on this real boundary.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 3, y: 60, width: 44, height: 44, top: 60, left: 3, right: 47, bottom: 104, toJSON: () => ({}),
    });
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
    expect(view.getByText("Authored history")).not.toBeVisible();
    await act(async () => { preparation.reject(new Error("NATIVE_CHROME_LAYOUT_UNCONFIRMED")); });
    expect(await result).toBe(true);
    expect(view.getByRole("button", { name: "Authored history" })).toHaveFocus();
    const activations = bridge.activate.mock.calls.length;
    act(() => { view.getByRole("button", { name: "Authored history" }).blur(); });
    await waitFor(() => expect(bridge.activate.mock.calls.length).toBeGreaterThan(activations));
    const delayedFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(delayedFocus.promise);
    const focusCalls = bridge.restoreFocus.mock.calls.length;
    act(() => { result = handle.current!.restoreFocus(true); });
    await waitFor(() => expect(bridge.restoreFocus.mock.calls.length).toBe(focusCalls + 1));
    const resized = bridge.restoreFocus.mock.calls.at(-1)![0];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 4, y: 60, width: 44, height: 44, top: 60, left: 4, right: 48, bottom: 104, toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(bridge.restoreFocus.mock.calls.length).toBe(focusCalls + 2));
    expect(await result).toBe(true);
    await act(async () => { delayedFocus.resolve({ ...resized, restored: true }); });
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();

    const displacedFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(displacedFocus.promise);
    act(() => { result = handle.current!.restoreFocus(true); });
    const displaced = bridge.restoreFocus.mock.calls.at(-1)![0];
    const onReplacement = vi.fn();
    const replacementHandle = createRef<NativeChatChromeHandle>();
    const replacement = render(<ChatHarness handle={replacementHandle} owner="new-mounted-owner" onAction={onReplacement} />);
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)?.[0].ownerEpoch).not.toBe(displaced.ownerEpoch));
    const replacementIdentity = bridge.activate.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => { displacedFocus.resolve({ ...displaced, restored: true }); });
    expect(await result).toBe(false);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    expect(view.container.querySelector("button")?.parentElement).toHaveAttribute("inert");
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...replacementIdentity, sequence: 1, privacyGeneration: 0, updateSequence: 0 }));
    await waitFor(() => expect(onReplacement).toHaveBeenCalledOnce());

    const oldDocumentFocus = deferred<Record<string, unknown>>();
    bridge.restoreFocus.mockReturnValueOnce(oldDocumentFocus.promise);
    act(() => { result = replacementHandle.current!.restoreFocus(true); });
    const oldDocument = bridge.restoreFocus.mock.calls.at(-1)![0];
    bridge.documentId = crypto.randomUUID();
    await act(async () => { oldDocumentFocus.resolve({ ...oldDocument, restored: true }); });
    expect(await result).toBe(false);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(replacement.queryByRole("button", { name: "Authored history" })).toBeNull();
  });

  it("keeps Drive attention accessible in the actual opener and out of native projections", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true });
    const fallback = createRef<HTMLButtonElement>();
    const opener = (pendingAttention: number, open = false, showAttentionDot = true) => <NativeHistoryOpener
      owner="synthetic-owner" context="chat:stable" eligible open={open}
      pendingAttention={pendingAttention} showAttentionDot={showAttentionDot} focusRef={fallback} onActivate={vi.fn()} />;
    const view = render(opener(1));
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    expect(view.getByRole("button", { name: "Open chat history, 1 Drive review needs you" })).toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(2));
    expect(view.getByRole("button", { name: "Open chat history, 2 Drive reviews need you" })).toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(2, false, false));
    expect(view.getByRole("button", { name: "Open chat history, 2 Drive reviews need you" })).toBeVisible();
    view.rerender(opener(2, true));
    expect(fallback.current).toHaveAttribute("aria-label", "Close chat history");
    expect(fallback.current).toHaveAttribute("aria-expanded", "true");
    expect(fallback.current).not.toBeVisible();
    expect(bridge.prepare).not.toHaveBeenCalled();
    view.rerender(opener(0));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    expect(fallback.current).toHaveAttribute("aria-label", "Open chat history");
    expect(bridge.prepare.mock.calls[0][0]).toMatchObject({ kind: "history", label: "Chat history" });
    expect(bridge.prepare.mock.calls[0][0]).not.toHaveProperty("pendingAttention");
    expect(view.queryByRole("button", { name: "Open chat history" })).toBeNull();
  });

  it.each([1, 0])("returns actual History opener focus after a DOM-owned surface becomes native eligible (click detail %s)", async (detail) => {
    measureSlot();
    const discovery = deferred<{ contractVersion: number; families: ["history"]; independentControls: boolean; focusReturn: boolean }>();
    bridge.getCapabilities.mockReturnValueOnce(discovery.promise);
    function OpenerJourney() {
      const [open, setOpen] = useState(false);
      const [didOpen, setDidOpen] = useState(false);
      const preference = useRef(false);
      const handle = useRef<NativeChatChromeHandle>(null), fallback = useRef<HTMLButtonElement>(null);
      useEffect(() => {
        if (!open && didOpen) void handle.current?.restoreFocus(preference.current);
      }, [open, didOpen]);
      return <>
        <NativeHistoryOpener owner="synthetic-owner" context="chat:stable" eligible={didOpen} open={open}
          pendingAttention={0} showAttentionDot focusRef={fallback} ref={handle}
          onActivate={(preferNative) => { preference.current = preferNative; setDidOpen(true); setOpen(true); }} />
        {open ? <NativeHistoryClose owner="synthetic-owner" context="history:stable" onClose={() => setOpen(false)} /> : null}
      </>;
    }
    const view = render(<OpenerJourney />);
    // An initially unqualified surface keeps its authored DOM control. Cold,
    // eligible surfaces are concealed instead (the discovery regression above).
    fireEvent.click(view.getByRole("button", { name: "Open chat history" }), { detail });
    await act(async () => discovery.resolve({ contractVersion: 2, families: ["history"], independentControls: true, focusReturn: true }));
    // Use the actual authored Close while it is still settling; do not infer
    // a control from DOM or call restoreFocus directly as the interaction.
    fireEvent.click(view.getByRole("button", { name: "Close chat history" }));
    if (detail > 0) {
      await waitFor(() => expect(bridge.restoreFocus).toHaveBeenCalledOnce());
      expect(view.queryByRole("button", { name: "Open chat history" })).toBeNull();
    } else {
      const opener = view.getByRole("button", { name: "Open chat history" });
      await waitFor(() => expect(opener).toHaveFocus());
      expect(bridge.restoreFocus).not.toHaveBeenCalled();
      const prepared = bridge.prepare.mock.calls.length;
      fireEvent(window, new Event("resize"));
      await act(async () => { await Promise.resolve(); });
      expect(bridge.prepare).toHaveBeenCalledTimes(prepared);
      act(() => opener.blur());
      await waitFor(() => expect(bridge.activate).toHaveBeenCalled());
    }
  });

  function Harness({ context = "/one/profile/security", owner = "synthetic-owner", suppressed = false, onBack = vi.fn(), eligible = true }) {
    useSessionChromeSuppression(suppressed);
    return <NativeShellBack label="Go back" onBack={onBack} owner={owner} context={context} eligible={eligible} />;
  }
  function measureSlot() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
  }

  function ProfileBackControl({ context, action, owner, suppressed, eligible }: {
    context: string; action: () => void; owner: string; suppressed: boolean; eligible: boolean;
  }) {
    useNativeNavigationBlocked(true, "profile-pane");
    useSessionChromeSuppression(suppressed);
    const focusRef = useRef<HTMLButtonElement>(null);
    return <NativeChatChrome kind="profile-back" label="Back in Profile" owner={owner} context={context}
      eligible={eligible} focusRef={focusRef} className="profile-back-slot" onActivate={action}>
      <button ref={focusRef}>Back in Profile</button>
    </NativeChatChrome>;
  }
  function retainedControl(kind: "back" | "history" | "profile-back", context: string, action = vi.fn(), owner = "synthetic-owner", suppressed = false, eligible = true) {
    if (kind === "profile-back") return <ProfileBackControl {...{ context, action, owner, suppressed, eligible }} />;
    return kind === "back" ? <Harness context={context} owner={owner} onBack={action} suppressed={suppressed} eligible={eligible} />
      : <ChatHarness context={context} owner={owner} onAction={action} suppressed={suppressed} eligible={eligible} />;
  }
  function admitReplacement(kind: "back" | "history" | "profile-back") {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [kind], independentControls: true,
      backReplacement: true, profileBackReplacement: true, historyReplacement: true, inPlaceUpdates: true });
    return kind === "history" ? bridge.prepareHistoryReplacement : bridge.prepareBackReplacement;
  }

  it.each(["back", "history", "profile-back"] as const)("hands off same-frame %s presentation without removal while expiring pending old actions", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const oldAction = vi.fn(), newAction = vi.fn();
    const view = render(retainedControl(kind, "original", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    const old = bridge.prepare.mock.calls[0][0];
    const confirmation = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(confirmation.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledOnce());
    const handoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(handoff.promise);
    const retirements = bridge.retire.mock.calls.length;
    view.rerender(retainedControl(kind, "replacement", newAction));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    const next = replacement.mock.calls[0][0];
    expect(next).toMatchObject({ previousRevision: old.revision, ownerEpoch: old.ownerEpoch, frame: old.frame });
    expect(next.revision).toBeGreaterThan(old.revision);
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.getByRole("button", { hidden: true })).not.toBeVisible();
    await act(async () => confirmation.resolve({ valid: true }));
    expect(oldAction).not.toHaveBeenCalled(); expect(newAction).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 2, updateSequence: 0, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce(); // Prepared is not interactive.
    await act(async () => handoff.resolve({ ...next, phase: "prepared" }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 3, updateSequence: 0, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...next, sequence: 3, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(newAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(old.controlId)).toBe(false));
  });

  it.each([ ["back", "refused"], ["back", "uncertain"], ["history", "refused"], ["history", "uncertain"], ["profile-back", "refused"], ["profile-back", "uncertain"] ] as const)("hard-retires either revision after %s %s replacement before restoring DOM", async (kind, outcome) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    replacement.mockRejectedValueOnce(new Error(outcome === "refused" ? "NATIVE_CHROME_REPLACEMENT_REFUSED" : "NATIVE_CHROME_ACK_UNCERTAIN"));
    const removed = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(removed.promise);
    const retirements = bridge.retire.mock.calls.length;
    view.rerender(retainedControl(kind, "replacement"));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(retirements + 1));
    const retirement = bridge.retire.mock.calls.at(-1)![0];
    expect(retirement.targetRevision).toBeUndefined(); // Refusal may leave the predecessor.
    expect(view.getByRole("button", { hidden: true })).not.toBeVisible();
    await act(async () => removed.resolve({ ...retirement, phase: "retired" }));
    await waitFor(() => expect(view.getByRole("button")).toBeVisible());
    expect(replacement).toHaveBeenCalledOnce(); // No retry/replay.
  });

  it.each(["back", "history", "profile-back"] as const)("removes pending %s handoff on unmount and cannot resurrect it on a late acknowledgement", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const handoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(handoff.promise);
    view.rerender(retainedControl(kind, "replacement"));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    const next = replacement.mock.calls[0][0];
    view.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(next.controlId)).toBe(false));
    expect(bridge.retire.mock.calls.at(-1)![0].targetRevision).toBeUndefined();
    await act(async () => handoff.resolve({ ...next, phase: "prepared" }));
    expect(bridge.activate).toHaveBeenCalledOnce();
  });

  it.each([
    ["back", "activation"], ["history", "activation"],
    ["back", "update"], ["history", "update"],
  ] as const)("keeps displaced %s fallback concealed after late %s failure", async (kind, phase) => {
    measureSlot();
    admitReplacement(kind);
    const pending = deferred<ChromeAcknowledgement>();
    if (phase === "activation") bridge.activate.mockReturnValueOnce(pending.promise);
    const oldAction = vi.fn(), currentAction = vi.fn();
    const previous = render(retainedControl(kind, "previous", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    if (phase === "update") {
      bridge.update.mockReturnValueOnce(pending.promise);
      act(() => {
        document.documentElement.style.setProperty("--app-accent", "#667788");
        writeAccent("gold");
      });
      await waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    }
    const fallback = within(previous.container).getByRole("button", { hidden: true });
    const focus = vi.spyOn(fallback, "focus");
    const currentView = render(retainedControl(kind, "current", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => pending.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(fallback).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    previous.unmount(); currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));
  });

  it.each(["back", "history"] as const)("does not remove a newer mounted %s control when its predecessor becomes inactive or unmounts", async (kind) => {
    measureSlot();
    admitReplacement(kind);
    const oldAction = vi.fn(), currentAction = vi.fn();
    const previous = render(retainedControl(kind, "previous", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const currentView = render(retainedControl(kind, "current", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const currentControl = bridge.prepare.mock.calls.at(-1)![0];
    const removals = bridge.retire.mock.calls.length;
    previous.rerender(retainedControl(kind, "previous", oldAction, "synthetic-owner", false, false));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(within(previous.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    previous.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(true);
    const currentDocument = bridge.documentId;
    bridge.documentId = crypto.randomUUID(); // Old-document cleanup cannot reserve a new-document tombstone.
    await retireOwnedNativeChrome(currentControl);
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    bridge.documentId = currentDocument;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...currentControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledOnce());
    expect(oldAction).not.toHaveBeenCalled();
    currentView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(currentControl.controlId)).toBe(false));

    // The predecessor's own removal can fail after a newer mount takes over.
    // Recovery must not turn that delayed failure into unqualified removal.
    const waiting = render(retainedControl(kind, "waiting", oldAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    const removal = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(removal.promise);
    const beforeRemoval = bridge.retire.mock.calls.length;
    waiting.rerender(retainedControl(kind, "waiting", oldAction, "synthetic-owner", false, false));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(beforeRemoval + 1));
    const latestView = render(retainedControl(kind, "latest", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    const latestControl = bridge.prepare.mock.calls.at(-1)![0];
    const beforeFailure = bridge.retire.mock.calls.length;
    await act(async () => { removal.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")); });
    expect(bridge.retire).toHaveBeenCalledTimes(beforeFailure);
    expect(within(waiting.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(latestControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latestControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(2));
    expect(oldAction).not.toHaveBeenCalled();
    waiting.unmount();
    latestView.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(latestControl.controlId)).toBe(false));

    // An active predecessor can fail without any same-instance rerender.
    const preparation = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValueOnce(preparation.promise);
    const preparations = bridge.prepare.mock.calls.length;
    const pending = render(retainedControl(kind, "pending-preparation", oldAction));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(preparations + 1));
    const succeeding = render(retainedControl(kind, "successful-preparation", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
    const successfulControl = bridge.prepare.mock.calls.at(-1)![0];
    const beforeRejection = bridge.retire.mock.calls.length;
    await act(async () => preparation.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(beforeRejection);
    expect(within(pending.container).getByRole("button", { hidden: true })).not.toBeVisible();
    expect(hasOutstandingNativeChrome(successfulControl.controlId)).toBe(true);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...successfulControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(3));
    expect(oldAction).not.toHaveBeenCalled();
    pending.unmount();
    succeeding.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(successfulControl.controlId)).toBe(false));

    // Successful, delayed retirement also cannot give an older mount a fresh
    // revision over a control that won the slot while it was waiting.
    const acknowledgedRemoval = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(acknowledgedRemoval.promise);
    const beforeWaiting = bridge.retire.mock.calls.length;
    const waitingForAck = render(retainedControl(kind, "waiting-ack", oldAction));
    await waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(beforeWaiting + 1));
    const oldRemoval = bridge.retire.mock.calls.at(-1)![0];
    const winner = render(retainedControl(kind, "won-during-ack", currentAction));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(6));
    const winningControl = bridge.prepare.mock.calls.at(-1)![0];
    const preparedBeforeAck = bridge.prepare.mock.calls.length;
    await act(async () => acknowledgedRemoval.resolve({ ...oldRemoval, phase: "retired" }));
    expect(bridge.prepare).toHaveBeenCalledTimes(preparedBeforeAck);
    expect(within(waitingForAck.container).getByRole("button", { hidden: true })).not.toBeVisible();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...winningControl, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(currentAction).toHaveBeenCalledTimes(4));
    expect(oldAction).not.toHaveBeenCalled();
    waitingForAck.unmount();
    winner.unmount();
    await waitFor(() => expect(hasOutstandingNativeChrome(winningControl.controlId)).toBe(false));
  });

  it.each(["back", "history"] as const)("cannot retire a newer %s after an older handoff fails late", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    const action = vi.fn();
    const view = render(retainedControl(kind, "original", action));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const oldHandoff = deferred<ChromeAcknowledgement>();
    replacement.mockReturnValueOnce(oldHandoff.promise);
    view.rerender(retainedControl(kind, "replacement", action));
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    // A prepared, unacknowledged predecessor is not eligible for retention.
    view.rerender(retainedControl(kind, "latest", action));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const latest = bridge.prepare.mock.calls.at(-1)![0];
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => oldHandoff.reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")));
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...latest, sequence: 1, updateSequence: 0, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
  });

  it.each(["back", "history", "profile-back"] as const)("never hands off %s across owner, suppression, native invalidation or geometry changes", async (kind) => {
    measureSlot();
    const replacement = admitReplacement(kind);
    // Model the native monotonic admission fence, not unconditional bridge
    // success. Reserving a preparation before retirement fails this journey.
    let tombstone = 0;
    bridge.retire.mockImplementation(async (value) => {
      tombstone = Math.max(tombstone, value.revision);
      return { ...value, phase: "retired" };
    });
    bridge.prepare.mockImplementation(async (value) => {
      if (value.revision <= tombstone) throw new Error("NATIVE_CHROME_PREPARE_REFUSED");
      tombstone = value.revision;
      return { ...value, phase: "prepared" };
    });
    const view = render(retainedControl(kind, "original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner", true));
    await waitFor(() => expect(view.getByRole("button")).toBeVisible());
    view.rerender(retainedControl(kind, "owner-replaced", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    act(() => bridge.callbacks.get("invalidated")?.(undefined));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 3, y: 60, width: 44, height: 44, top: 60, left: 3, right: 47, bottom: 104, toJSON: () => ({}),
    });
    view.rerender(retainedControl(kind, "moved", undefined, "other-owner"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["back", "history"] as const)("retains an admitted %s lease on unchanged geometry, not on geometry or authority changes", async (kind) => {
    admitChat();
    let x = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x, y: 60, width: 44, height: 44, top: 60, left: x, right: x + 44, bottom: 104, toJSON: () => ({}),
    }));
    const action = vi.fn();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const renderControl = (context: string) => kind === "back"
      ? <Harness context={context} onBack={action} /> : <ChatHarness context={context} onAction={action} />;
    const view = render(renderControl("original"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    const retirements = bridge.retire.mock.calls.length;
    fireEvent(window, new Event("resize"));
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    const initial = bridge.prepare.mock.calls[0][0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...initial, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    x = 3; // A real one-pixel move still invalidates immediately.
    fireEvent(window, new Event("resize"));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...initial, sequence: 2, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenCalledOnce();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(window.innerWidth - 1);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(3));
    act(() => bridge.callbacks.get("invalidated")?.(undefined)); // Same coordinates, invalid native authority.
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(4));
    view.rerender(renderControl("replacement")); // Same coordinates, new route/action context.
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(5));
  });

  it("binds Profile Back to its layer and rejects pending or old-stack choices beneath a newer overlay", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back", "profile-back", "close"], independentControls: true });
    const back = vi.fn();
    function ProfileBackHarness({ blocked = false, context = "account" }: { blocked?: boolean; context?: string }) {
      useNativeNavigationBlocked(true, "profile-pane");
      useNativeNavigationBlocked(blocked);
      const focusRef = useRef<HTMLButtonElement>(null);
      return <NativeChatChrome kind="profile-back" label="Back in Profile" owner="owner-a" context={context}
        eligible focusRef={focusRef} className="profile-back-slot" onActivate={back}>
        <button ref={focusRef}>Back in Profile</button>
      </NativeChatChrome>;
    }
    const view = render(<ProfileBackHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.prepare.mock.calls[0][0];
    expect(old.controlId).toBe("profile-back");
    // Close and route Back must not route a choice to the Profile stack.
    for (const controlId of ["profile-close", "top-shell-back"]) {
      act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, controlId, sequence: 1, privacyGeneration: 0 }));
    }
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledOnce());
    view.rerender(<ProfileBackHarness blocked />);
    await act(async () => approval.resolve({ valid: true }));
    expect(back).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Back in Profile" })).toBeVisible());
    view.rerender(<ProfileBackHarness context="security" />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 2, privacyGeneration: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledOnce();
    const current = bridge.prepare.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...current, sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(back).toHaveBeenCalledOnce());
  });
  it("keeps stationary Profile Close native across inner-stack changes, never across owner replacement", async () => {
    measureSlot();
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["profile-back", "close"], independentControls: true, inPlaceUpdates: true, profileBackReplacement: true });
    const close = vi.fn();
    const view = render(<ProfilePane open owner="owner-a" onOpenChange={close} />);
    const preparedCloses = () => bridge.prepare.mock.calls.filter(([p]) => p.kind === "close");
    await waitFor(() => expect(preparedCloses()).toHaveLength(1));
    await waitFor(() => expect(bridge.activate.mock.calls.some(([p]) => p.controlId === "profile-close")).toBe(true));
    await act(async () => { await Promise.resolve(); });
    const original = preparedCloses()[0]![0];
    profile.query = "profile_pane=1&profile_panel=security";
    view.rerender(<ProfilePane open owner="owner-a" onOpenChange={(next) => close(next)} />);
    await act(async () => { await Promise.resolve(); });
    expect(view.getByLabelText("Close Profile", { selector: "button" }).closest('[inert]')).not.toBeNull();
    expect(bridge.retire.mock.calls.some(([p]) => p.controlId === "profile-close" && p.targetRevision === original.revision)).toBe(false);
    await waitFor(() => expect(bridge.prepare.mock.calls.some(([p]) => p.kind === "profile-back")).toBe(true));
    expect(preparedCloses()).toHaveLength(1);
    await waitFor(() => expect(bridge.activate.mock.calls.some(([p]) => p.controlId === "profile-back")).toBe(true));
    const previousBack = bridge.prepare.mock.calls.find(([p]) => p.kind === "profile-back")![0];
    const handoff = deferred<ChromeAcknowledgement>();
    bridge.prepareBackReplacement.mockReturnValueOnce(handoff.promise);
    const removals = bridge.retire.mock.calls.length;
    profile.query = "profile_pane=1&profile_panel=security&profile_detail=vault";
    view.rerender(<ProfilePane open owner="owner-a" onOpenChange={close} />);
    await act(async () => { await Promise.resolve(); });
    // The outer header does not slide with the content stack. Its Back stays
    // native but gets fresh action authority; no 300ms web fallback interval.
    expect(bridge.retire).toHaveBeenCalledTimes(removals);
    expect(view.getByLabelText("Back in Profile", { selector: "button" }).closest('[inert]')).not.toBeNull();
    await waitFor(() => expect(bridge.prepareBackReplacement).toHaveBeenCalledOnce());
    const nextBack = bridge.prepareBackReplacement.mock.calls[0][0];
    expect(nextBack).toMatchObject({ controlId: "profile-back", previousRevision: previousBack.revision, frame: previousBack.frame });
    await act(async () => handoff.resolve({ ...nextBack, phase: "prepared" }));
    await waitFor(() => expect(bridge.activate.mock.calls.some(([p]) => p.revision === nextBack.revision)).toBe(true));
    expect(preparedCloses()).toHaveLength(1);
    const updateSequence = bridge.update.mock.calls.find(([p]) => p.controlId === "profile-close")?.[0].updateSequence ?? 0;
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...original, sequence: 1, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(false));
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(pending.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...original, sequence: 2, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(bridge.confirmChoice).toHaveBeenCalledTimes(2));
    view.rerender(<ProfilePane open owner="owner-b" onOpenChange={close} />);
    await act(async () => { pending.resolve({ valid: true }); });
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...original, sequence: 3, updateSequence, privacyGeneration: 0 }));
    await waitFor(() => expect(preparedCloses()).toHaveLength(2));
    expect(preparedCloses()[1]![0].ownerEpoch).not.toBe(original.ownerEpoch);
    expect(close).toHaveBeenCalledOnce();
  });

  it("admits History Close only after settlement and never bypasses a newer overlay", async () => {
    measureSlot();
    document.documentElement.style.setProperty("--motion-sheet-enter-duration", "300ms");
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["history"], independentControls: true, inPlaceUpdates: true });
    const close = vi.fn();
    function CloseHarness({ blocked = false }: { blocked?: boolean }) {
      useNativeNavigationBlocked(true, "chat-history");
      useNativeNavigationBlocked(blocked);
      return <NativeHistoryClose owner="owner-a" context="chat-a" onClose={close} />;
    }
    const view = render(<CloseHarness />);
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Close chat history" })).toBeVisible();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("button", { name: "Close chat history" })).toBeNull();
    const installed = bridge.activate.mock.calls.at(-1)![0];
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...installed, sequence: 1, privacyGeneration: 0, updateSequence: 0 }));
    expect(bridge.confirmChoice).toHaveBeenCalledTimes(1);
    view.rerender(<CloseHarness blocked />);
    await act(async () => { approval.resolve({ valid: true }); });
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Close chat history" })).toBeVisible());
    view.rerender(<CloseHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const current = bridge.activate.mock.calls.at(-1)![0];
    await act(async () => { await Promise.resolve(); });
    expect(bridge.update).not.toHaveBeenCalled();
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...current, sequence: 1, privacyGeneration: 0, updateSequence: 0 }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    view.unmount();
    document.documentElement.style.removeProperty("--motion-sheet-enter-duration");
  });
  it("commits DOM isolation before activation and waits for retirement during session checks", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    const button = view.getByRole("button", { name: "Go back" });
    bridge.activate.mockImplementation(async (value) => {
      expect(button).toBeDisabled();
      expect(button).toHaveStyle({ visibility: "hidden" });
      return { ...value, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalled());
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...bridge.activate.mock.calls.at(-1)![0], sequence: 1, privacyGeneration: 0 }));
    const pending = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValue(pending.promise);
    view.rerender(<Harness suppressed onBack={onBack} />);
    await act(async () => { approval.resolve({ valid: true }); });
    expect(onBack).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    await waitFor(() => expect(bridge.retire.mock.calls.at(-1)?.[0].revision).toBeGreaterThan(bridge.activate.mock.calls.at(-1)![0].revision));
    await act(async () => { pending.resolve({ ...bridge.retire.mock.calls.at(-1)![0], phase: "retired" }); });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).not.toHaveStyle({ visibility: "hidden" });
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
  });
  it("does not remove a replacement when old activation fails after a context change", async () => {
    measureSlot();
    const pending = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    view.rerender(<Harness context="/one/profile/account" />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => { pending.reject(new Error("synthetic_old_ack_failure")); });
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(view.getByRole("button", { hidden: true })).toBeDisabled();
  });
  it("applies committed theme tokens and rejects an old-theme choice during replacement", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    const old = bridge.activate.mock.calls.at(-1)![0];
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    await act(async () => {
      document.documentElement.style.setProperty("--app-accent", "#112233");
      document.documentElement.style.setProperty("--app-accent-deep", "#445566");
      document.documentElement.classList.add("dark");
      // Resolve before React commits the observer's replacement projection.
      // A class-only change must fence the old control immediately too.
      approval.resolve({ valid: true });
      await approval.promise;
    });
    expect(onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", accentHex: "#112233", foregroundHex: "#445566",
    }));
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)![0].revision).toBeGreaterThan(old.revision));
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    act(() => {
      document.documentElement.style.setProperty("--app-accent", "#667788");
      writeAccent("gold");
    });
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0].accentHex).toBe("#667788"));
  });
  it.each(["web", "android", "older-ios", "older-wrapper", "older-single-control-wrapper"])("retains the existing control on %s", async (platform) => {
    bridge.platform = platform.startsWith("older-") ? "ios" : platform;
    if (platform === "older-ios") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    if (platform === "older-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 1, families: ["back"] });
    if (platform === "older-single-control-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"] });
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(view.getByRole("button", { name: "Go back" })).not.toBeDisabled();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
});
