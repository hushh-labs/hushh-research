import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeNavigation, useNativeNavigationOverlayRef, useNativeNavigationBottomInset, useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const bridge = vi.hoisted(() => ({
  platform: "web", supported: true,
  callbacks: new Map<string, (event: unknown) => void>(),
  setState: vi.fn(), getCapabilities: vi.fn(),
  confirmSelection: vi.fn(), sequence: 0,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: () => ({
    getCapabilities: bridge.getCapabilities,
    setState: bridge.setState,
    confirmSelection: bridge.confirmSelection,
    addListener: async (name: string, callback: (event: unknown) => void) => {
      bridge.callbacks.set(name, callback);
      return { remove: async () => { bridge.callbacks.delete(name); } };
    },
  }),
}));
const options = { enabled: true, visible: true, selected: "chat" as const, feedAttention: false,
  appearance: "light" as const, accentHex: "#112233", foregroundHex: "#223344" };
function Overlay() { return <div ref={useNativeNavigationOverlayRef<HTMLDivElement>()} />; }
function PersistentHistory({ open }: { open: boolean }) { useNativeNavigationBlocked(open); return <div />; }
function lastState() { return bridge.setState.mock.calls.at(-1)![0]; }
function select(state: ReturnType<typeof lastState>, tab = "dashboard") {
  act(() => bridge.callbacks.get("selectionRequested")?.({ ...state, tab, privacyGeneration: 0, sequence: ++bridge.sequence }));
}

describe("native navigation presentation boundary", () => {
  beforeEach(() => {
    bridge.platform = "ios";
    bridge.callbacks.clear();
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 2, supported: true, contentHeight: 49, bottomInset: 34 });
    bridge.setState.mockReset().mockResolvedValue({ supported: true, contentHeight: 49, bottomInset: 34 });
    bridge.confirmSelection.mockReset().mockResolvedValue({ valid: true });
    bridge.sequence = 0;
  });
  afterEach(async () => { await act(async () => { await Promise.resolve(); }); });

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
  it("retains the web bar when a wrapper cannot acknowledge the themed contract", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 1, supported: true, contentHeight: 49, bottomInset: 34 });
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
    const privacy = bridge.callbacks.get("privacyStateChanged")!;
    act(() => privacy({ action: "state", generation: 1, cause: "inactive", shielded: true, appIsActive: false }));
    act(() => privacy({ action: "state", generation: 1, cause: "inactive", shielded: false, appIsActive: true }));
    await act(async () => { settle({ valid: true }); });
    expect(onSelect).not.toHaveBeenCalled();
    select(lastState());
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("dashboard"));
    view.unmount();
  });
});
