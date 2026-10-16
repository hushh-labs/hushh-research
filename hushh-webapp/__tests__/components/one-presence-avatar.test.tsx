import { act, cleanup, render, waitFor as realWaitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePresenceAvatar, resolveOnePresenceState } from "@/components/agent/one-presence-avatar";

const runtime = vi.hoisted(() => ({ instances: [] as Array<{ options: { enableRiveAssetCDN: boolean; onLoad: () => void; onLoadError: () => void; src: string }; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn>; stopRendering: ReturnType<typeof vi.fn>; startRendering: ReturnType<typeof vi.fn>; resizeDrawingSurfaceToCanvas: ReturnType<typeof vi.fn> }> }));
vi.mock("@rive-app/canvas", () => ({
  RuntimeLoader: { setWasmUrl: vi.fn(), setWasmFallbackUrl: vi.fn() },
  Fit: { Contain: "contain" }, Alignment: { Center: "center" },
  Layout: class {},
  Rive: class {
    play = vi.fn(); pause = vi.fn(); cleanup = vi.fn(); stopRendering = vi.fn();
    startRendering = vi.fn(); resizeDrawingSurfaceToCanvas = vi.fn(); resizeToCanvas = vi.fn();
    constructor(public options: typeof runtime.instances[number]["options"]) { runtime.instances.push(this); }
  },
}));

const lifecycle = vi.hoisted(() => ({ state: "active", listeners: new Set<() => void>() }));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: lifecycle.state }),
    subscribeLifecycle: (listener: () => void) => { lifecycle.listeners.add(listener); return () => lifecycle.listeners.delete(listener); },
  },
}));

let media: EventTarget & { matches: boolean };
type ViewportCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const viewportCallbacks = new Set<ViewportCallback>();
const enterViewport: ViewportCallback = entries => viewportCallbacks.forEach(callback => callback(entries));
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1254);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D);
  runtime.instances.length = 0;
  viewportCallbacks.clear();
  lifecycle.state = "active"; lifecycle.listeners.clear();
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: ViewportCallback) { viewportCallbacks.add(callback); }
    observe() {} disconnect() { viewportCallbacks.delete(this.callback); }
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, "decode", originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

// Advance presentation time in separate React commits, as browser frames do.
async function waitFor(assertion: () => void) {
  if (!vi.isFakeTimers()) return realWaitFor(assertion);
  let failure: unknown;
  for (let elapsed = 0; elapsed <= 8000; elapsed += 50) {
    try { assertion(); return; } catch (error) { failure = error; }
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  }
  throw failure;
}

async function loadVisibleAvatar(view: ReturnType<typeof render>) {
  act(() => enterViewport([{ isIntersecting: true }]));
  await waitFor(() => expect(runtime.instances).toHaveLength(1));
  act(() => runtime.instances[0].options.onLoad());
  await waitFor(() => expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible"));
  return runtime.instances[0];
}

describe("OnePresenceAvatar playback lifecycle", () => {
  it.each([
    ["connected", "thinking"], ["thinking", "working"],
    ["working", "answering"], ["answering", "connected"],
  ] as const)("keeps painted %s artwork visible for three seconds before %s", async (initial, next) => {
    vi.useFakeTimers();
    const view = render(<OnePresenceAvatar state={initial} />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    view.rerender(<OnePresenceAvatar state={next} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe(initial);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe(next);
  });

  it("retains brief Working and Answering phases, bounds repeated requests, then catches up", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    act(() => enterViewport([{ isIntersecting: true }]));
    const shown: string[] = [];
    for (const state of ["working", "answering", "working", "thinking", "answering", "connected"] as const) {
      view.rerender(<OnePresenceAvatar state={state} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    }
    // Task state is already idle while its brief activities remain perceptible.
    expect(view.container.firstElementChild).toHaveAttribute("data-one-presence-state", "connected");
    for (const state of ["working", "answering", "thinking", "connected"]) {
      await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", state));
      shown.push(state);
      expect(view.container.querySelectorAll("canvas").length).toBeLessThanOrEqual(2);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(shown).toEqual(["working", "answering", "thinking", "connected"]);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the minimum interval after delayed artwork is painted, including reduced motion", async () => {
    media.matches = true;
    let decode!: () => void;
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementationOnce(() => new Promise<void>(resolve => { decode = resolve; }));
    const view = render(<OnePresenceAvatar state="working" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => decode());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    view.rerender(<OnePresenceAvatar state="answering" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2800); });
    expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "working");
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "answering"));
    expect(runtime.instances).toHaveLength(0);
  });

  it("retains outgoing pixels when both incoming assets fail and recovers on a later state", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    await loadVisibleAvatar(view);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    view.rerender(<OnePresenceAvatar state="working" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    act(() => runtime.instances[1].options.onLoadError());
    view.rerender(<OnePresenceAvatar state="answering" />);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(true);
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "answering"));
    view.rerender(<OnePresenceAvatar state="working" />);
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "working"));
  });

  it("does not duplicate the current runtime when an unavailable queued state returns to it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<OnePresenceAvatar state="thinking" />);
    const original = await loadVisibleAvatar(view);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    view.rerender(<OnePresenceAvatar state="working" />);
    view.rerender(<OnePresenceAvatar state="thinking" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(original.cleanup).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not count background time as a visible interval and cancels pending work on disposal", async () => {
    const view = render(<OnePresenceAvatar state="working" />);
    await loadVisibleAvatar(view);
    view.rerender(<OnePresenceAvatar state="answering" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    act(() => { lifecycle.state = "active"; lifecycle.listeners.forEach(listener => listener()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "working");
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "answering"));
    view.unmount();
    expect(lifecycle.listeners.size).toBe(0);
    expect(viewportCallbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains one live instance across StrictMode preflight and size changes", async () => {
    const view = render(<StrictMode><OnePresenceAvatar state="connected" className="size-13" /></StrictMode>);
    expect(viewportCallbacks.size).toBe(2);
    const instance = await loadVisibleAvatar(view);
    const canvas = view.container.querySelector("canvas");
    view.rerender(<StrictMode><OnePresenceAvatar state="connected" className="size-22" /></StrictMode>);
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(runtime.instances).toHaveLength(1);
    expect(instance.cleanup).not.toHaveBeenCalled();
    view.unmount();
    expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.listeners.size).toBe(0);
  });

  it("waits for the SDK load callback to return before resizing or starting playback", async () => {
    // At DPR1 the compact canvas must resize, which can synchronously draw.
    // Rive prepares its paused state machine after invoking the load callback.
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 44, height: 44 } as DOMRect);
    render(<OnePresenceAvatar state="connected" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(1));
    const instance = runtime.instances[0];
    act(() => {
      instance.options.onLoad();
      expect(instance.resizeDrawingSurfaceToCanvas).not.toHaveBeenCalled();
      expect(instance.startRendering).not.toHaveBeenCalled();
    });
    await waitFor(() => expect(instance.play).toHaveBeenCalledWith("State Machine 1"));
    expect(instance.resizeDrawingSurfaceToCanvas).toHaveBeenCalled();
  });

  it("animates connected using its native asset and pauses playback while the app is backgrounded", async () => {
    const view = render(<OnePresenceAvatar state="connected" presentation="profile" className="size-48" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/one-presence/profile-hd.png");
    expect(runtime.instances).toHaveLength(0);
    const instance = await loadVisibleAvatar(view);
    expect(instance.options.src).toBe("/one-presence/hd/connected.riv");
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    expect(instance.stopRendering).toHaveBeenCalled();
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    act(() => { lifecycle.state = "active"; lifecycle.listeners.forEach(listener => listener()); });
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible");
    view.unmount(); expect(lifecycle.listeners.size).toBe(0);
  });
  it("does not load Rive under reduced motion, and pauses an active loop when motion is reduced", async () => {
    media.matches = true;
    const view = render(<OnePresenceAvatar state="working" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    expect(runtime.instances).toHaveLength(0);
    act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
    await waitFor(() => expect(runtime.instances).toHaveLength(1));
    act(() => runtime.instances[0].options.onLoad());
    await waitFor(() => expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible"));
    expect(runtime.instances[0].play).toHaveBeenCalledWith("State Machine 1");
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    expect(runtime.instances[0].pause).toHaveBeenCalledWith("State Machine 1");
    expect(runtime.instances[0].stopRendering).toHaveBeenCalled();
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
  });

  it("retains painted outgoing artwork while queued assets load and ignores disposed callbacks", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    // Both replacement portraits are unavailable, so native paint owns readiness.
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    view.rerender(<OnePresenceAvatar state="answering" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    const pending = runtime.instances[1];
    expect(pending.options.src).toBe("/one-presence/hd/answering.riv");
    expect(pending.options.enableRiveAssetCDN).toBe(false);
    expect(old.cleanup).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("style")).toContain("opacity: 1");
    expect(view.container.querySelector('[data-one-presence-layer="current"] canvas')?.getAttribute("style")).toContain("visibility: visible");
    view.rerender(<OnePresenceAvatar state="working" />);
    expect(pending.cleanup).not.toHaveBeenCalled();
    act(() => pending.options.onLoad());
    await waitFor(() => expect(old.cleanup).toHaveBeenCalledOnce());
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe("answering");
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(3));
    const replacement = runtime.instances[2];
    act(() => replacement.options.onLoad());
    await waitFor(() => expect(pending.cleanup).toHaveBeenCalledOnce());
    act(() => pending.options.onLoad());
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(view.container.querySelector('[data-one-presence-artwork]')?.getAttribute("data-one-presence-artwork")).toBe("working");
    view.unmount();
    expect(replacement.cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.listeners.size).toBe(0);
  });

  it("shows the current activity's decoded portrait while its animation is still loading", async () => {
    const view = render(<OnePresenceAvatar state="connected" />);
    const old = await loadVisibleAvatar(view);
    let releaseDecode!: () => void;
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementationOnce(() => new Promise<void>(resolve => { releaseDecode = resolve; }));
    view.rerender(<OnePresenceAvatar state="thinking" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    const pending = runtime.instances[1];
    // complete/naturalWidth alone do not prove an async image can be drawn.
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe("connected");
    expect(old.cleanup).not.toHaveBeenCalled();
    await act(async () => releaseDecode());
    // No Rive onLoad: a slow animation must not hide the activity's ready portrait.
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe("thinking"));
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    expect(view.container.querySelector("img")?.style.visibility).toBe("visible");
    expect(pending.play).not.toHaveBeenCalled();
    // The new DOM can commit before React flushes passive unmount cleanup.
    await waitFor(() => expect(old.cleanup).toHaveBeenCalledOnce());
    view.rerender(<OnePresenceAvatar state="connected" />);
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe("connected"));
    await waitFor(() => expect(pending.cleanup).toHaveBeenCalledOnce());
    act(() => pending.options.onLoad());
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("data-one-presence-artwork")).toBe("connected");
  });

  it("waits for a delayed reduced-motion poster before removing painted outgoing artwork", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    view.rerender(<OnePresenceAvatar state="working" />);
    const poster = view.container.querySelector('[data-one-presence-layer="incoming"] img')!;
    expect(old.cleanup).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("style")).toContain("opacity: 1");
    expect(view.container.querySelector('[data-one-presence-layer="incoming"]')?.getAttribute("style")).toContain("opacity: 0");
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(true);
    act(() => poster.dispatchEvent(new Event("load")));
    await waitFor(() => expect(old.cleanup).toHaveBeenCalledOnce());
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/one-presence/drafting-hd.png");
    expect(runtime.instances).toHaveLength(1);
  });

  it("cancels a pending first render when backgrounded and waits for a fresh render on resume", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    let painted = false;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      clearRect: vi.fn(), drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, painted ? 255 : 0]) }),
    } as unknown as CanvasRenderingContext2D);
    const view = render(<OnePresenceAvatar state="answering" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(1));
    await act(async () => runtime.instances[0].options.onLoad());
    expect(frames.size).toBe(2);
    const unpainted = [...frames.values()]; frames.clear();
    act(() => unpainted.forEach(callback => callback(performance.now())));
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    expect(frames.size).toBe(2);
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    expect(frames.size).toBe(0);
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    act(() => { lifecycle.state = "active"; lifecycle.listeners.forEach(listener => listener()); });
    painted = true;
    for (let i = 0; i < 2; i++) {
      const callbacks = [...frames.values()]; frames.clear();
      act(() => callbacks.forEach(callback => callback(performance.now())));
    }
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible");
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it("settles a reversal to the original phase while its outgoing layer is retained", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    view.rerender(<OnePresenceAvatar state="answering" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    const answering = runtime.instances[1];
    act(() => answering.options.onLoad());
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-artwork="answering"]')?.getAttribute("style")).toContain("opacity: 1"));
    view.rerender(<OnePresenceAvatar state="thinking" />);
    await waitFor(() => expect(view.container.querySelectorAll("canvas")).toHaveLength(1));
    expect(view.container.querySelector('[data-one-presence-artwork]')?.getAttribute("data-one-presence-artwork")).toBe("thinking");
    expect(old.cleanup).not.toHaveBeenCalled();
    // Passive disposal follows the DOM commit; wait for both lifecycle facts.
    await waitFor(() => expect(answering.cleanup).toHaveBeenCalledOnce());
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("freezes painted playback when backgrounded before its HD fallback loads", async () => {
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    expect(old.stopRendering).toHaveBeenCalled();
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible");
    expect(view.container.querySelector("img")?.style.visibility).toBe("hidden");
    act(() => { lifecycle.state = "active"; lifecycle.listeners.forEach(listener => listener()); });
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(true);
    await act(async () => view.container.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible");
    expect(view.container.querySelector("img")?.style.visibility).toBe("hidden");
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    expect(view.container.querySelector("img")?.style.visibility).toBe("visible");
  });

  it("stops offscreen rendering and retains the poster after an asset failure", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const instance = await loadVisibleAvatar(view);
    act(() => enterViewport([{ isIntersecting: false }]));
    expect(instance.stopRendering).toHaveBeenCalled();
    act(() => instance.options.onLoadError());
    expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(view.container.querySelector("img")?.style.visibility).toBe("visible");
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
  });
});

describe("One activity presentation", () => {
  it("uses distinct waiting and output states, with active work taking priority", () => {
    expect(resolveOnePresenceState({ drafting: false, answering: false, thinking: false })).toBe("connected");
    expect(resolveOnePresenceState({ drafting: false, answering: false, thinking: true })).toBe("thinking");
    expect(resolveOnePresenceState({ drafting: false, answering: true, thinking: true })).toBe("answering");
    expect(resolveOnePresenceState({ drafting: true, answering: true, thinking: true })).toBe("working");
    expect(resolveOnePresenceState({ working: true, drafting: false, answering: true, thinking: true })).toBe("working");
    expect(resolveOnePresenceState({ working: false, drafting: false, answering: false, thinking: true })).toBe("thinking");
  });
});
