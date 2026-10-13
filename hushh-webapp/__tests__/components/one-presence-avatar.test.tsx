import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePresenceAvatar } from "@/components/agent/one-presence-avatar";

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
let enterViewport: (entries: Array<{ isIntersecting: boolean }>) => void;
beforeEach(() => {
  runtime.instances.length = 0;
  lifecycle.state = "active"; lifecycle.listeners.clear();
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof enterViewport) { enterViewport = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function loadVisibleAvatar() {
  act(() => enterViewport([{ isIntersecting: true }]));
  await waitFor(() => expect(runtime.instances).toHaveLength(1));
  act(() => runtime.instances[0].options.onLoad());
  return runtime.instances[0];
}

describe("OnePresenceAvatar playback lifecycle", () => {
  it("keeps idle as an HD still and pauses the active runtime while the app is backgrounded", async () => {
    const view = render(<OnePresenceAvatar state="connected" presentation="profile" className="size-48" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/one-presence/profile-hd.png");
    expect(runtime.instances).toHaveLength(0);
    view.rerender(<OnePresenceAvatar state="working" presentation="profile" className="size-48" />);
    const instance = await loadVisibleAvatar();
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
    expect(runtime.instances[0].play).toHaveBeenCalledWith("State Machine 1");
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    expect(runtime.instances[0].pause).toHaveBeenCalledWith("State Machine 1");
    expect(runtime.instances[0].stopRendering).toHaveBeenCalled();
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
  });

  it("cleans up the old WASM instance on a state change and ignores its late load callback", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const old = await loadVisibleAvatar();
    view.rerender(<OnePresenceAvatar state="answering" />);
    expect(old.cleanup).toHaveBeenCalledOnce();
    act(() => old.options.onLoad());
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
    act(() => enterViewport([{ isIntersecting: true }]));
    await waitFor(() => expect(runtime.instances).toHaveLength(2));
    expect(runtime.instances[1].options.src).toBe("/one-presence/thinking.riv");
    expect(runtime.instances[1].options.enableRiveAssetCDN).toBe(false);
    view.unmount();
    expect(runtime.instances[1].cleanup).toHaveBeenCalledOnce();
  });

  it("stops offscreen rendering and retains the poster after an asset failure", async () => {
    const view = render(<OnePresenceAvatar state="thinking" />);
    const instance = await loadVisibleAvatar();
    act(() => enterViewport([{ isIntersecting: false }]));
    expect(instance.stopRendering).toHaveBeenCalled();
    act(() => instance.options.onLoadError());
    expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(view.container.querySelector("img")?.style.visibility).toBe("visible");
    expect(view.container.querySelector("canvas")?.style.visibility).toBe("hidden");
  });
});
