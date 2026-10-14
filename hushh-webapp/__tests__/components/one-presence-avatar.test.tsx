import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePresenceAvatar, resolveOnePresenceState } from "@/components/agent/one-presence-avatar";

const runtime = vi.hoisted(() => ({ instances: [] as Array<{ options: { enableRiveAssetCDN: boolean; onLoad: () => void; onLoadError: () => void; src: string }; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn>; stopRendering: ReturnType<typeof vi.fn> }> }));
vi.mock("@rive-app/canvas", () => ({
  RuntimeLoader: { setWasmUrl: vi.fn(), setWasmFallbackUrl: vi.fn() },
  Fit: { Contain: "contain" }, Alignment: { Center: "center" },
  Layout: class {},
  Rive: class {
    play = vi.fn(); pause = vi.fn(); cleanup = vi.fn(); stopRendering = vi.fn();
    startRendering = vi.fn(); resizeDrawingSurfaceToCanvas = vi.fn();
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
beforeEach(() => {
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function loadVisibleAvatar(view: ReturnType<typeof render>) {
  act(() => enterViewport([{ isIntersecting: true }]));
  await waitFor(() => expect(runtime.instances).toHaveLength(1));
  act(() => runtime.instances[0].options.onLoad());
  await waitFor(() => expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible"));
  return runtime.instances[0];
}

describe("OnePresenceAvatar playback lifecycle", () => {
  it("animates connected using its native asset and pauses playback while the app is backgrounded", async () => {
    const view = render(<OnePresenceAvatar state="connected" presentation="profile" className="size-48" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/one-presence/profile-hd.png");
    expect(runtime.instances).toHaveLength(0);
    const instance = await loadVisibleAvatar(view);
    expect(instance.options.src).toBe("/one-presence/connected.riv");
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

  it("retains the outgoing runtime until replacement playback is ready, and ignores superseded loads", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    view.rerender(<OnePresenceAvatar state="answering" />);
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    const pending = runtime.instances[1];
    expect(pending.options.src).toBe("/one-presence/answering.riv");
    expect(pending.options.enableRiveAssetCDN).toBe(false);
    expect(old.cleanup).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-one-presence-layer="current"]')?.getAttribute("style")).toContain("opacity: 1");
    expect(view.container.querySelector('[data-one-presence-layer="current"] canvas')?.getAttribute("style")).toContain("visibility: visible");
    view.rerender(<OnePresenceAvatar state="working" />);
    expect(pending.cleanup).toHaveBeenCalledOnce();
    act(() => pending.options.onLoad());
    expect(old.cleanup).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-one-presence-layer="incoming"]')?.getAttribute("style")).toContain("opacity: 0");
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(3));
    const replacement = runtime.instances[2];
    act(() => replacement.options.onLoad());
    await waitFor(() => expect(view.container.querySelector('[data-one-presence-layer="incoming"]')?.getAttribute("style")).toContain("opacity: 1"));
    expect(old.cleanup).not.toHaveBeenCalled();
    await waitFor(() => expect(old.cleanup).toHaveBeenCalledOnce());
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(view.container.querySelector('[data-one-presence-artwork]')?.getAttribute("data-one-presence-artwork")).toBe("working");
    view.unmount();
    expect(replacement.cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.listeners.size).toBe(0);
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
    act(() => runtime.instances[0].options.onLoad());
    expect(frames.size).toBe(1);
    const unpainted = [...frames.values()]; frames.clear();
    act(() => unpainted.forEach(callback => callback(performance.now())));
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    expect(frames.size).toBe(1);
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
    expect(answering.cleanup).toHaveBeenCalledOnce();
    expect(runtime.instances).toHaveLength(2);
  });

  it("freezes painted playback when backgrounded before its HD fallback loads", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar(view);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(false);
    act(() => { lifecycle.state = "background"; lifecycle.listeners.forEach(listener => listener()); });
    expect(old.stopRendering).toHaveBeenCalled();
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("visible");
    expect(view.container.querySelector("img")?.style.visibility).toBe("hidden");
    act(() => { lifecycle.state = "active"; lifecycle.listeners.forEach(listener => listener()); });
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!.get!).mockReturnValue(true);
    act(() => view.container.querySelector("img")!.dispatchEvent(new Event("load")));
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
  it("uses distinct waiting and output states, with actual draft generation taking priority", () => {
    expect(resolveOnePresenceState({ drafting: false, answering: false, thinking: false })).toBe("connected");
    expect(resolveOnePresenceState({ drafting: false, answering: false, thinking: true })).toBe("thinking");
    expect(resolveOnePresenceState({ drafting: false, answering: true, thinking: true })).toBe("answering");
    expect(resolveOnePresenceState({ drafting: true, answering: true, thinking: true })).toBe("working");
  });
});
