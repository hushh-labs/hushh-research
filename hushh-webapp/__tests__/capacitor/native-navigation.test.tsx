import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeNavigation, useNativeNavigationOverlayRef, useNativeNavigationBottomInset, useNativeNavigationBlocked, useNativeNavigationBlockedUntilSettled, useNativeNavigationScrollFollowing } from "@/lib/capacitor/native-navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { measureNativeNavigationColumn } from "@/lib/capacitor/native-navigation-column";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { nativeDrawerIsolation, subscribeNativeDrawerIsolation, type NativeDrawerIsolation } from "@/lib/capacitor/native-drawers";
import { NativeNavigationScrollDelivery } from "@/lib/capacitor/native-navigation-scroll";
import { onScroll, resetKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { completeNativeSessionPrivacyValidation } from "@/lib/capacitor/session-privacy";
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: vi.fn(() => true) }));

const bridge = vi.hoisted(() => ({
  platform: "web", supported: true,
  callbacks: new Map<string, (event: unknown) => void>(),
  setState: vi.fn(), getCapabilities: vi.fn(), setScroll: vi.fn(),
  confirmSelection: vi.fn(), sequence: 0,
  regions: vi.fn(),
  completeSessionValidation: vi.fn(),
}));
vi.mock("@/lib/capacitor/native-presentation-regions", () => ({
  syncNativePresentationRegions: bridge.regions,
  setNativePresentationRegionIsolation: vi.fn(),
  useNativeOverlayCollisionPadding: (padding: unknown) => padding,
  useNativePresentationRegionRevision: () => 0,
  nativePresentationAdmission: () => ({}),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: () => ({
    getCapabilities: bridge.getCapabilities,
    setState: bridge.setState,
    setScroll: bridge.setScroll,
    confirmSelection: bridge.confirmSelection,
    completeSessionValidation: bridge.completeSessionValidation,
    addListener: async (name: string, callback: (event: unknown) => void) => {
      bridge.callbacks.set(name, callback);
      return { remove: async () => { bridge.callbacks.delete(name); } };
    },
  }),
}));
const options = { enabled: true, visible: true, selected: "chat" as const, feedAttention: false,
  column: { x: 16, width: 361, contentHeight: 64, viewportWidth: 393 },
  appearance: "light" as const, accentHex: "#112233", foregroundHex: "#223344" };
function Overlay() { return <div ref={useNativeNavigationOverlayRef<HTMLDivElement>()} />; }
function PersistentHistory({ open }: { open: boolean }) { useNativeNavigationBlocked(open); return <div />; }
function lastState() { return bridge.setState.mock.calls.at(-1)![0]; }
function select(state: ReturnType<typeof lastState>, tab = "dashboard") {
  act(() => bridge.callbacks.get("selectionRequested")?.({ ...state, tab, privacyGeneration: 0, sequence: ++bridge.sequence }));
}

describe("native navigation presentation boundary", () => {
  beforeEach(() => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(true);
    bridge.platform = "ios";
    bridge.callbacks.clear();
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, contentHeight: 49, bottomInset: 34 });
    bridge.setState.mockReset().mockResolvedValue({ supported: true, contentHeight: 49, bottomInset: 34 });
    bridge.confirmSelection.mockReset().mockResolvedValue({ valid: true });
    bridge.sequence = 0;
    bridge.completeSessionValidation.mockReset().mockResolvedValue({
      released: true, generation: 1, cause: "inactive", shielded: false, appIsActive: true,
    });
    bridge.regions.mockReset().mockResolvedValue(true);
    bridge.setScroll.mockReset().mockResolvedValue({ applied: true });
    resetKaiBottomChromeVisibility();
  });
  afterEach(async () => { await act(async () => { await Promise.resolve(); }); });

  it("measures only bounded canonical slot geometry", () => {
    const element = document.createElement("div");
    const rectangle = { x: 16, width: 361, height: 64 };
    const measure = vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => rectangle as DOMRect);
    expect(measureNativeNavigationColumn(element)).toEqual({ x: 16, width: 361, contentHeight: 64, viewportWidth: window.innerWidth });
    for (const invalid of [{ x: -1 }, { width: 180 }, { height: 160 }, { x: window.innerWidth }, { width: Number.NaN }]) {
      measure.mockReturnValue({ ...rectangle, ...invalid } as DOMRect);
      expect(measureNativeNavigationColumn(element)).toBeNull();
    }
    expect(measureNativeNavigationColumn(null)).toBeNull();
  });
  it("projects shared scroll without React rerenders only after native capability and state admission", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, synchronizedBottomScroll: true,
      wholeNativeDrawers: true, interactionIsolation: true, contentHeight: 49, bottomInset: 34 });
    bridge.setState.mockImplementation(async state => ({ supported: true, contentHeight: 49, bottomInset: 34,
      scrollGeneration: state.revision, privacyGeneration: 0, scrollFollowing: state.scrollFollowing }));
    let renders = 0;
    const view = renderHook(() => { renders++; return useNativeNavigation({ ...options, onSelect: vi.fn() }); });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    await waitFor(() => expect(bridge.setScroll).toHaveBeenCalled());
    const before = renders;
    act(() => { onScroll(0); onScroll(30); onScroll(60); });
    await waitFor(() => expect(bridge.setScroll.mock.calls.at(-1)?.[0].progress).toBeGreaterThan(0));
    expect(renders).toBe(before);
    expect(bridge.setScroll.mock.calls.at(-1)?.[0]).toMatchObject({
      documentId: lastState().documentId, revision: lastState().revision,
      interactionEpoch: lastState().interactionEpoch, scrollGeneration: lastState().revision, travel: 55,
    });
    act(() => bridge.callbacks.get("geometryChanged")?.({ supported: true, documentId: lastState().documentId,
      revision: lastState().revision, contentHeight: 60, bottomInset: 34,
      scrollGeneration: lastState().revision, privacyGeneration: 0, scrollFollowing: true }));
    await waitFor(() => expect(bridge.setScroll.mock.calls.at(-1)?.[0].travel).toBe(66));
    const overlay = render(<Overlay />);
    await waitFor(() => expect(lastState().interactionEnabled).toBe(false));
    const blocked = bridge.setScroll.mock.calls.length;
    act(() => onScroll(110));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.setScroll).toHaveBeenCalledTimes(blocked);
    overlay.unmount(); view.unmount();
  });

  it("requires acknowledged pinned state after a scroll delivery failure instead of leaving CSS moving alone", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, synchronizedBottomScroll: true,
      wholeNativeDrawers: true, interactionIsolation: true, contentHeight: 49, bottomInset: 34 });
    bridge.setState.mockImplementation(async state => ({ supported: true, contentHeight: 49, bottomInset: 34,
      scrollGeneration: state.revision, privacyGeneration: 0, scrollFollowing: state.scrollFollowing }));
    bridge.setScroll.mockRejectedValue(new Error("synthetic transport refusal"));
    const view = renderHook(() => ({ navigation: useNativeNavigation({ ...options, onSelect: vi.fn() }),
      following: useNativeNavigationScrollFollowing() }));
    await waitFor(() => expect(lastState().scrollFollowing).toBe(false));
    expect(bridge.setState.mock.calls.some(([state]) => state.scrollFollowing === true)).toBe(true);
    expect(view.result.current.following).toBe(false);
    expect(view.result.current.navigation.ready).toBe(true);
    expect(bridge.setScroll).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("does not treat a timeout as cancellation or dispatch another scroll while the original remains outstanding", async () => {
    vi.useFakeTimers();
    let settle!: (value: { applied: boolean }) => void;
    const send = vi.fn(() => new Promise<{ applied: boolean }>(resolve => { settle = resolve; }));
    const unavailable = vi.fn();
    const delivery = new NativeNavigationScrollDelivery({ setScroll: send }, unavailable);
    try {
      const binding = { documentId: "public", revision: 1, interactionEpoch: 1, privacyGeneration: 0, scrollGeneration: 1, travel: 55 };
      delivery.update(binding); delivery.publish(1);
      await vi.advanceTimersByTimeAsync(3001);
      expect(unavailable).toHaveBeenCalledOnce();
      delivery.update({ ...binding, revision: 2 }); delivery.publish(0.5);
      expect(send).toHaveBeenCalledOnce();
      settle({ applied: true }); await Promise.resolve();
      expect(send).toHaveBeenCalledOnce();
    } finally { delivery.stop(); vi.useRealTimers(); }
  });

  it("coalesces slow native scroll delivery and drops old pending poses across a binding change", async () => {
    let acknowledge!: (value: { applied: boolean }) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
      .mockResolvedValue({ applied: true });
    const delivery = new NativeNavigationScrollDelivery({ setScroll: send });
    const binding = { documentId: "public", revision: 1, interactionEpoch: 1, privacyGeneration: 0, scrollGeneration: 1, travel: 55 };
    delivery.update(binding);
    for (let index = 1; index <= 100; index++) delivery.publish(index / 100);
    expect(send).toHaveBeenCalledTimes(1);
    acknowledge({ applied: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toMatchObject({ progress: 1, sequence: 101 });
    delivery.update(null);
    delivery.publish(0.3);
    expect(send).toHaveBeenCalledTimes(2);
    delivery.update({ ...binding, scrollGeneration: 3 });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][0]).toMatchObject({ progress: 0.3, scrollGeneration: 3 });
    delivery.stop(); delivery.publish(1);
    await act(async () => { await Promise.resolve(); });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(["underlayPresentation", "contentBackedPresentation", "reservedPresentationRegions"])(
    "uses web fallback for an old experimental %s wrapper instead of reserving a stranded native bar", async (capability) => {
      vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
      bridge.regions.mockResolvedValue(false);
      bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, [capability]: true });
      const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
      await waitFor(() => expect(view.result.current.reserved).toBe(false));
      expect(view.result.current.ready).toBe(false);
      expect(bridge.setState).not.toHaveBeenCalled();
      expect(bridge.regions).not.toHaveBeenCalled();
      view.unmount();
    });
  it("retains standard native navigation in recovery and isolates full-height React overlays", async () => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, interactionIsolation: true, contentHeight: 49, bottomInset: 34 });
    bridge.regions.mockResolvedValue(false);
    const action = vi.fn();
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: action }));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.height).toBe(49);
    const before = lastState();
    const overlay = render(<Overlay />);
    await waitFor(() => expect(lastState()).toMatchObject({ visible: false, interactionEnabled: false }));
    select(before);
    expect(action).not.toHaveBeenCalled();
    overlay.unmount();
    await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: true }));
    select(before); expect(action).not.toHaveBeenCalled();
    expect(bridge.regions).not.toHaveBeenCalled();
    view.unmount();
  });

  it("isolates a retained overlay only through its visible lifetime and ignores a superseded exit", async () => {
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    function RetainedOverlay({ open }: { open: boolean }) {
      return <div data-testid="retained-overlay" data-state={open ? "open" : "closed"}
        ref={useNativeNavigationOverlayRef<HTMLDivElement>()} />;
    }
    const overlay = render(<RetainedOverlay open={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(lastState().interactionEnabled).toBe(true);
    overlay.rerender(<RetainedOverlay open />);
    await waitFor(() => expect(lastState().interactionEnabled).toBe(false));
    const node = overlay.getByTestId("retained-overlay");
    await act(async () => { node.hidden = true; });
    await waitFor(() => expect(lastState().interactionEnabled).toBe(true));
    await act(async () => { node.hidden = false; });
    await waitFor(() => expect(lastState().interactionEnabled).toBe(false));
    let finishExit!: () => void;
    const finished = new Promise<void>(resolve => { finishExit = resolve; });
    node.getAnimations = () => [{ finished, playState: "running",
      effect: { target: node, getComputedTiming: () => ({ iterations: 1 }) } } as unknown as Animation];
    overlay.rerender(<RetainedOverlay open={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(lastState().interactionEnabled).toBe(false);
    overlay.rerender(<RetainedOverlay open />);
    await act(async () => { finishExit(); await finished; });
    expect(lastState().interactionEnabled).toBe(false);
    node.getAnimations = () => [];
    overlay.rerender(<RetainedOverlay open={false} />);
    await waitFor(() => expect(lastState().interactionEnabled).toBe(true));
    overlay.unmount(); view.unmount();
  });

  it("keeps native tabs materially present beneath a whole native drawer without the legacy clipping protocol", async () => {
    vi.mocked(customNativePresentationEnabled).mockReturnValue(false);
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, supported: true, wholeNativeDrawers: true, interactionIsolation: true, contentHeight: 49, bottomInset: 34 });
    const action = vi.fn();
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: action }));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const before = lastState();
    const overlay = render(<Overlay />);
    await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: false }));
    select(before);
    expect(action).not.toHaveBeenCalled();
    overlay.unmount();
    await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: true }));
    expect(bridge.regions).not.toHaveBeenCalled();
    view.unmount();
  });

  it("rejects a pre-drawer tap even if native confirmation arrives after a complete isolation cycle", async () => {
    let isolate!: (state: NativeDrawerIsolation) => void;
    const handle = await subscribeNativeDrawerIsolation({
      getCapabilities: async () => nativeDrawerIsolation(),
      addListener: async (_, callback) => { isolate = callback; return { remove: async () => undefined }; },
    });
    const before = nativeDrawerIsolation().generation;
    let confirm!: (result: { valid: boolean }) => void;
    bridge.confirmSelection.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const action = vi.fn();
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: action }));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    select(lastState());
    isolate({ generation: before + 1, isolated: true });
    isolate({ generation: before + 2, isolated: false });
    await act(async () => { confirm({ valid: true }); });
    expect(action).not.toHaveBeenCalled();
    view.unmount();
    await handle.remove();
  });

  it.each(["web", "android"])("does not replace or call the native bar on %s", async (platform) => {
    bridge.platform = platform;
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current.ready).toBe(false);
    expect(bridge.getCapabilities).not.toHaveBeenCalled();
    expect(bridge.setState).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the web fallback when an older iOS wrapper reports unsupported", async () => {
    bridge.getCapabilities.mockResolvedValue({ supported: false, contentHeight: 0 });
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    expect(view.result.current.ready).toBe(false);
    expect(bridge.setState).not.toHaveBeenCalled();
    view.unmount();
  });
  it("keeps the shared DOM column when an older wrapper cannot accept its geometry", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, supported: true, contentHeight: 49, bottomInset: 34 });
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    expect(view.result.current.ready).toBe(false);
    expect(bridge.setState).not.toHaveBeenCalled();
    view.unmount();
  });

  it("projects the canonical column and hides native controls if the slot becomes invalid", async () => {
    const view = renderHook(({ column }) => useNativeNavigation({ ...options, column, onSelect: vi.fn() }), {
      initialProps: { column: options.column as typeof options.column | null },
    });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(lastState().column).toEqual(options.column);
    view.rerender({ column: { x: 47, width: 768, contentHeight: 64, viewportWidth: 862 } });
    await waitFor(() => expect(lastState().column.width).toBe(768));
    view.rerender({ column: null });
    await waitFor(() => expect(lastState().visible).toBe(false));
    expect(lastState().column.width).toBe(768);
    view.unmount();
  });

  it("holds History coverage through actual exit and ignores a cancelled close after reopen", async () => {
    const ref = createRef<HTMLDivElement>(); ref.current = document.createElement("div");
    let finish: () => void = () => undefined;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    ref.current.getAnimations = () => [{ effect: { target: ref.current, getComputedTiming: () => ({ iterations: 1 }) }, finished } as unknown as Animation];
    const view = renderHook(({ open }) => {
      useNativeNavigationBlockedUntilSettled(open, "chat-history", ref);
      return useNativeNavigation({ ...options, onSelect: vi.fn() });
    }, { initialProps: { open: true } });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    view.rerender({ open: false });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(lastState().interactionEnabled).toBe(false);
    view.rerender({ open: true });
    await act(async () => { finish(); });
    expect(lastState().interactionEnabled).toBe(false);
    view.rerender({ open: false });
    await waitFor(() => expect(lastState().interactionEnabled).toBe(true));
    view.unmount();
  });
  it.each([1, 2])("retains the four-tab web bar for older native contract %s", async (contractVersion) => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion, columnLayout: true, supported: true, contentHeight: 49, bottomInset: 34 });
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect: vi.fn() }));
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    expect(view.result.current.ready).toBe(false);
    expect(bridge.setState).not.toHaveBeenCalled();
    view.unmount();
  });

  it("accepts only current allowed taps and isolates mounted overlays and hidden vault chrome", async () => {
    const onSelect = vi.fn();
    const view = renderHook(({ visible, feedAttention, appearance, accentHex }) => useNativeNavigation({ ...options, visible, feedAttention, appearance, accentHex, onSelect }), {
      initialProps: { visible: true, feedAttention: false, appearance: "light" as "light" | "dark", accentHex: "#112233" },
    });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const original = lastState();
    select(original);
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("dashboard"));
    view.rerender({ visible: true, feedAttention: true, appearance: "dark", accentHex: "#445566" });
    await waitFor(() => expect(lastState().revision).toBeGreaterThan(original.revision));
    expect(lastState()).toMatchObject({ appearance: "dark", accentHex: "#445566", interactionEpoch: original.interactionEpoch });
    select(original, "feed"); // A badge/theme revision must not drop the final native tap.
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith("feed"));
    onSelect.mockClear();
    select(original, "search");
    expect(onSelect).not.toHaveBeenCalled();
    select(original, "arbitrary-url");
    expect(onSelect).not.toHaveBeenCalled();

    const overlay = render(<Overlay />);
    select(original); // Reject immediately, even before the native hide acknowledgement arrives.
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(lastState().visible).toBe(false));
    overlay.unmount();
    await waitFor(() => expect(lastState().visible).toBe(true));
    select(original); // Old revision cannot act after reopening.
    expect(onSelect).not.toHaveBeenCalled();
    select(lastState());
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("dashboard"));
    onSelect.mockClear();
    const visibleState = lastState();
    view.rerender({ visible: false, feedAttention: true, appearance: "dark", accentHex: "#445566" });
    select(visibleState);
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(lastState().visible).toBe(false));
    view.unmount();
    await waitFor(() => expect(lastState().revision).toBeGreaterThan(visibleState.revision));
    expect(lastState().visible).toBe(false);
  });

  it("reserves the actual native bottom inset and isolates a default non-modal dialog and persistent history", async () => {
    const onSelect = vi.fn();
    const view = renderHook(() => ({
      navigation: useNativeNavigation({ ...options, onSelect }), inset: useNativeNavigationBottomInset(),
    }));
    await waitFor(() => expect(view.result.current.navigation.ready).toBe(true));
    expect(view.result.current.inset).toBe(34);
    const history = render(<PersistentHistory open={false} />);
    expect(lastState().visible).toBe(true);
    history.rerender(<PersistentHistory open />);
    await waitFor(() => expect(lastState().visible).toBe(false));
    history.rerender(<PersistentHistory open={false} />);
    await waitFor(() => expect(lastState().visible).toBe(true));
    const dialog = render(<Dialog open><DialogContent><DialogTitle>Recovery</DialogTitle></DialogContent></Dialog>);
    await waitFor(() => expect(lastState().visible).toBe(false));
    dialog.unmount();
    await waitFor(() => expect(lastState().visible).toBe(true));
    bridge.confirmSelection.mockResolvedValueOnce({ valid: false }); // Native privacy cycle changed.
    select(lastState());
    await waitFor(() => expect(bridge.confirmSelection).toHaveBeenCalled());
    expect(onSelect).not.toHaveBeenCalled();
    history.unmount();
    view.unmount();
  });

  it("drops an approved but delayed tap across a privacy cycle even after visibility returns", async () => {
    const onSelect = vi.fn();
    let settle: (result: { valid: boolean }) => void = () => undefined;
    bridge.confirmSelection.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect }));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    select(lastState());
    const priorRevision = lastState().revision;
    const privacy = bridge.callbacks.get("privacyStateChanged")!;
    act(() => privacy({ action: "state", generation: 1, cause: "inactive", shielded: true, appIsActive: false }));
    // Native completion may release the cover without broadcasting a listener
    // event. Observe the existing authoritative completion, not a fake event.
    await act(async () => { await completeNativeSessionPrivacyValidation(1); });
    await waitFor(() => expect(lastState().revision).toBeGreaterThan(priorRevision));
    expect(lastState().interactionEnabled).toBe(true);
    const admittedRevision = lastState().revision;
    act(() => privacy({ action: "state", generation: 1, cause: "inactive", shielded: false, appIsActive: true }));
    await act(async () => { await Promise.resolve(); });
    expect(lastState().revision).toBe(admittedRevision);
    await act(async () => { settle({ valid: true }); });
    expect(onSelect).not.toHaveBeenCalled();
    select(lastState());
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("dashboard"));
    view.unmount();
  });

  it("retains negotiated navigation through repeated drawer cycles without admitting covered or stale choices", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, interactionIsolation: true, supported: true, contentHeight: 49, bottomInset: 34 });
    const onSelect = vi.fn();
    const view = renderHook(({ interactive, visible }) => useNativeNavigation({ ...options, visible, interactionEnabled: interactive, onSelect }), {
      initialProps: { interactive: true, visible: true },
    });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const history = render(<PersistentHistory open={false} />);
    let confirm: (result: { valid: boolean }) => void = () => undefined;
    bridge.confirmSelection.mockReturnValueOnce(new Promise((resolve) => { confirm = resolve; }));
    select(lastState());
    await waitFor(() => expect(bridge.confirmSelection).toHaveBeenCalled());
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const before = lastState();
      history.rerender(<PersistentHistory open />);
      select(before); // Fence immediately, before the bridge acknowledges.
      await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: false }));
      expect(view.result.current.height).toBe(49);
      history.rerender(<PersistentHistory open={false} />);
      await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: true }));
      select(before); // Cannot replay an old choice after reopening.
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(bridge.setState.mock.calls.every(([state]) => state.visible)).toBe(true);
    await act(async () => { confirm({ valid: true }); });
    expect(onSelect).not.toHaveBeenCalled(); // A delayed approval cannot cross a covered epoch.
    view.rerender({ interactive: false, visible: true });
    await waitFor(() => expect(lastState()).toMatchObject({ visible: true, interactionEnabled: false }));
    select(lastState());
    expect(onSelect).not.toHaveBeenCalled();
    view.rerender({ interactive: true, visible: false }); // Lock/route hiding must still conceal.
    await waitFor(() => expect(lastState()).toMatchObject({ visible: false, interactionEnabled: false }));
    history.unmount();
    view.unmount();
  });

  it.each([false, true])("keeps page paint intact; reserved regions=%s negotiate overlay visibility", async (reserved) => {
    const shell = document.createElement("main");
    shell.dataset.appShellRoot = "true";
    document.body.appendChild(shell);
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, interactionIsolation: true,
      contentBackedPresentation: true, reservedPresentationRegions: reserved, underlayPresentation: false, supported: true, contentHeight: 49, bottomInset: 34 });
    const onSelect = vi.fn();
    const view = renderHook(() => useNativeNavigation({ ...options, onSelect }));
    let overlay: ReturnType<typeof render> | undefined;
    try {
      await waitFor(() => expect(view.result.current.ready).toBe(true));
      expect(lastState().visible).toBe(true);
      expect(shell.style.clipPath).toBe("");
      expect(document.documentElement.classList.contains("native-compositor-apertures")).toBe(false);
      const before = lastState();
      overlay = render(<Overlay />);
      select(before);
      expect(onSelect).not.toHaveBeenCalled();
      await waitFor(() => expect(lastState()).toMatchObject({ visible: reserved, interactionEnabled: false }));
      overlay.unmount(); overlay = undefined;
      await waitFor(() => expect(lastState().visible).toBe(true));
      select(before);
      expect(onSelect).not.toHaveBeenCalled();
      select(lastState());
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
      expect(shell.style.clipPath).toBe("");
    } finally { overlay?.unmount(); view.unmount(); shell.remove(); }
  });

  it("exposes only acknowledged underlay geometry and rejects stale layout after hiding", async () => {
    const shell = document.createElement("main");
    shell.dataset.appShellRoot = "true";
    document.body.appendChild(shell);
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 3, columnLayout: true, interactionIsolation: true, underlayPresentation: true,
      supported: true, contentHeight: 49, bottomInset: 34 });
    bridge.setState.mockResolvedValue({ supported: true, contentHeight: 49, bottomInset: 34,
      frame: { x: 0, y: 400, width: 300, height: 83 } });
    const view = renderHook(({ visible }) => useNativeNavigation({ ...options, visible, onSelect: vi.fn() }), {
      initialProps: { visible: true },
    });
    try {
      await waitFor(() => expect(view.result.current.ready).toBe(true));
      expect(shell.style.clipPath).toContain("M0 400h300v83");
      const original = lastState();
      act(() => bridge.callbacks.get("geometryChanged")?.({ ...original,
        frame: { x: 0, y: 380, width: 310, height: 83 }, contentHeight: 49, bottomInset: 34 }));
      expect(shell.style.clipPath).toContain("M0 380h310v83");
      view.rerender({ visible: false });
      await waitFor(() => expect(shell.style.clipPath).toBe(""));
      act(() => bridge.callbacks.get("geometryChanged")?.({ ...original,
        frame: { x: 0, y: 400, width: 300, height: 83 }, contentHeight: 2, bottomInset: 0 }));
      expect(shell.style.clipPath).toBe("");
      expect(view.result.current.height).toBe(49);
    } finally { view.unmount(); shell.remove(); }
  });
});
