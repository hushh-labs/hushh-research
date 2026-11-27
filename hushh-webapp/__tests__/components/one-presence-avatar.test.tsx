import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnePresenceState } from "@/components/agent/one-presence-avatar";

type RiveOptions = {
  canvas: HTMLCanvasElement;
  buffer: ArrayBuffer;
  enableRiveAssetCDN: boolean;
  onLoad: () => void;
  onLoadError: () => void;
};

const runtime = vi.hoisted(() => ({
  instances: [] as Array<{
    options: RiveOptions;
    play: ReturnType<typeof vi.fn>;
    stopRendering: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    resizeDrawingSurfaceToCanvas: ReturnType<typeof vi.fn>;
  }>,
  ready: vi.fn(),
}));
vi.mock("@rive-app/canvas", () => ({
  RuntimeLoader: {
    setWasmUrl: vi.fn(), setWasmFallbackUrl: vi.fn(), setWasmBinary: vi.fn(), awaitInstance: runtime.ready,
  },
  Fit: { Contain: "contain" }, Alignment: { Center: "center" },
  Layout: class {},
  Rive: class {
    play = vi.fn();
    pause = vi.fn();
    cleanup = vi.fn();
    stopRendering = vi.fn();
    resizeToCanvas = vi.fn();
    resizeDrawingSurfaceToCanvas = vi.fn(() => {
      this.options.canvas.width = 44;
      this.options.canvas.height = 44;
    });
    constructor(public options: RiveOptions) { runtime.instances.push(this); }
  },
}));

const lifecycle = vi.hoisted(() => ({ state: "active", listeners: new Set<() => void>() }));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: lifecycle.state }),
    subscribeLifecycle: (listener: () => void) => {
      lifecycle.listeners.add(listener);
      return () => lifecycle.listeners.delete(listener);
    },
  },
}));

type ViewportCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const viewport = new Set<ViewportCallback>();
let media: EventTarget & { matches: boolean };
let presence: typeof import("@/components/agent/one-presence-avatar");
const fetchAsset = vi.fn();
const decode = vi.fn();
const pixels = vi.fn();
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");

beforeEach(async () => {
  vi.resetModules();
  presence = await import("@/components/agent/one-presence-avatar");
  vi.useFakeTimers();
  runtime.instances.length = 0;
  runtime.ready.mockReset().mockResolvedValue(undefined);
  lifecycle.state = "active";
  lifecycle.listeners.clear();
  viewport.clear();
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: ViewportCallback) { viewport.add(callback); }
    observe() {}
    disconnect() { viewport.delete(this.callback); }
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  fetchAsset.mockReset().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", fetchAsset);
  decode.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(320);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 44, height: 44 } as DOMRect);
  pixels.mockReset().mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 255]) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), drawImage: vi.fn(), getImageData: pixels,
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, "decode", originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

const advance = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setViewport = (isIntersecting: boolean) => act(() => viewport.forEach(callback => callback([{ isIntersecting }])));
const setMotion = (reduced: boolean) => act(() => {
  media.matches = reduced;
  media.dispatchEvent(new Event("change"));
});
const setLifecycle = (state: string) => act(() => {
  lifecycle.state = state;
  lifecycle.listeners.forEach(listener => listener());
});

function mount(initial: OnePresenceState = "connected", profile = false) {
  const { OnePresenceAvatar } = presence;
  const element = (state: OnePresenceState) => (
    <StrictMode><OnePresenceAvatar state={state} presentation={profile ? "profile" : "compact"} /></StrictMode>
  );
  const view = render(element(initial));
  const layer = () => view.container.querySelector<HTMLElement>('[data-one-presence-layer="current"]')!;
  return {
    ...view,
    pose: (state: OnePresenceState) => view.rerender(element(state)),
    layer,
    canvas: () => layer().querySelector("canvas")!,
    poster: () => layer().querySelector("img")!,
    fallback: () => layer().querySelector<HTMLElement>("[data-one-presence-fallback]")!,
  };
}

async function paint(index: number) {
  const instance = runtime.instances[index]!;
  act(() => instance.options.onLoad());
  await advance(32);
  return instance;
}

describe("One mascot", () => {
  it("paints the cold compact asset and reuses it on remount", async () => {
    const first = mount();
    setViewport(true);
    await advance();
    expect(first.poster()).toBeVisible();
    expect(first.canvas()).not.toBeVisible();
    expect(runtime.instances).toHaveLength(1);
    const instance = runtime.instances[0]!;
    expect(instance.options.enableRiveAssetCDN).toBe(false);
    act(() => instance.options.onLoad());
    expect(instance.play).not.toHaveBeenCalled();
    await advance(32);
    expect(first.canvas()).toBeVisible();
    expect(instance.resizeDrawingSurfaceToCanvas).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(instance.cleanup).toHaveBeenCalledOnce();

    const next = mount();
    setViewport(true);
    await advance();
    await paint(1);
    expect(next.canvas()).toBeVisible();
    expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
      "/one-presence/compact/connected.riv", "/one-presence/rive.wasm",
    ]);
  });

  it("follows a 250ms turn and drops pending artwork and callbacks", async () => {
    const avatar = mount();
    setViewport(true);
    await advance();
    const idle = await paint(0);
    avatar.pose("thinking");
    await advance(125);
    const thinking = runtime.instances[1]!;
    avatar.pose("working");
    await advance(125);
    const working = runtime.instances[2]!;
    avatar.pose("connected");
    act(() => {
      thinking.options.onLoad();
      thinking.options.onLoadError();
      working.options.onLoad();
    });
    await advance(250);
    expect(avatar.layer()).toHaveAttribute("data-one-presence-artwork", "connected");
    expect(avatar.layer()).toHaveStyle({ opacity: 1 });
    expect(avatar.canvas()).toBeVisible();
    expect(avatar.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(thinking.cleanup).toHaveBeenCalledOnce();
    expect(working.cleanup).toHaveBeenCalledOnce();
    expect(idle.cleanup).not.toHaveBeenCalled();
    await advance(5000);
    expect(runtime.instances).toHaveLength(3);
  });

  it("shows the correct poster while loading and an embedded still if the poster never decodes", async () => {
    const avatar = mount("working", true);
    setViewport(true);
    await advance();
    expect(avatar.poster()).toBeVisible();
    expect(avatar.poster()).toHaveAttribute("src", "/one-presence/drafting-hd.png");
    decode.mockImplementation(() => new Promise(() => {}));
    avatar.pose("connected");
    await advance(100);
    expect(avatar.layer()).toHaveAttribute("data-one-presence-artwork", "working");
    expect(avatar.poster()).toBeVisible();
    await advance(60);
    await advance(200);
    expect(avatar.layer()).toHaveAttribute("data-one-presence-artwork", "connected");
    expect(avatar.poster()).not.toBeVisible();
    expect(avatar.fallback()).toBeVisible();
    expect(avatar.fallback().style.backgroundImage).toContain("data:image/webp;base64,");
  });

  it("uses a still when the image request fails", async () => {
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth")!.get!).mockReturnValue(0);
    const avatar = mount("answering");
    fireEvent.error(avatar.poster());
    expect(avatar.poster()).not.toBeVisible();
    expect(avatar.fallback()).toBeVisible();
  });

  it("retries a failed asset and cleans up the failed instance", async () => {
    const avatar = mount("thinking");
    setViewport(true);
    await advance();
    act(() => runtime.instances[0]!.options.onLoadError());
    await advance(250);
    expect(runtime.instances).toHaveLength(2);
    expect(runtime.instances[0]!.cleanup).toHaveBeenCalledOnce();
    expect(avatar.poster()).toBeVisible();
    await paint(1);
    expect(avatar.canvas()).toBeVisible();
  });

  it("aborts hanging asset requests and stops retrying after two attempts", async () => {
    const signals: AbortSignal[] = [];
    fetchAsset.mockImplementation((url: string, { signal }: { signal: AbortSignal }) => {
      if (url.endsWith(".wasm")) return Promise.resolve(new Response("wasm"));
      signals.push(signal);
      return new Promise(() => {});
    });
    const avatar = mount("thinking");
    setViewport(true);
    await advance(10_000);
    expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
    expect(runtime.instances).toHaveLength(0);
    expect(avatar.poster()).toBeVisible();
    expect(avatar.canvas()).toHaveAttribute("data-one-presence-playback", "load-timeout");
  });

  it("recovers when the shared runtime rejects once", async () => {
    runtime.ready.mockRejectedValueOnce(new Error("WASM rejected"));
    const avatar = mount();
    setViewport(true);
    await advance(250);
    expect(runtime.ready).toHaveBeenCalledTimes(2);
    expect(runtime.instances).toHaveLength(1);
    await paint(0);
    expect(avatar.canvas()).toBeVisible();
  });

  it("times out transparent first frames and destroys both instances", async () => {
    pixels.mockReturnValue({ data: new Uint8ClampedArray(4) });
    const avatar = mount("thinking");
    setViewport(true);
    await advance();
    await paint(0);
    await advance(4700);
    await paint(1);
    await advance(4500);
    for (const instance of runtime.instances) expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(runtime.instances).toHaveLength(2);
    expect(avatar.poster()).toBeVisible();
    expect(avatar.canvas()).toHaveAttribute("data-one-presence-playback", "paint-timeout");
  });

  it("pauses offscreen and when reduced motion changes, then resumes the same canvas", async () => {
    media.matches = true;
    const avatar = mount();
    setViewport(true);
    await advance();
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(avatar.poster()).toBeVisible();
    setMotion(false);
    await advance();
    const instance = await paint(0);
    setViewport(false);
    expect(instance.stopRendering).toHaveBeenCalled();
    expect(avatar.poster()).toBeVisible();
    setViewport(true);
    expect(avatar.canvas()).toBeVisible();
    setMotion(true);
    expect(avatar.canvas()).not.toBeVisible();
    expect(avatar.poster()).toBeVisible();
    setMotion(false);
    expect(avatar.canvas()).toBeVisible();
    expect(runtime.instances).toHaveLength(1);
  });

  it("resumes only the latest background pose and cleans up on unmount", async () => {
    const avatar = mount("working");
    setViewport(true);
    await advance();
    const working = await paint(0);
    setLifecycle("background");
    avatar.pose("answering");
    avatar.pose("connected");
    await advance(5000);
    expect(working.stopRendering).toHaveBeenCalled();
    expect(avatar.layer()).toHaveAttribute("data-one-presence-artwork", "connected");
    expect(avatar.poster()).toBeVisible();
    setLifecycle("active");
    await advance();
    const idle = await paint(1);
    expect(avatar.canvas()).toBeVisible();
    avatar.unmount();
    expect(idle.cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.listeners.size).toBe(0);
    expect(viewport.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ drafting: false, answering: false, thinking: false }, "connected"],
    [{ drafting: false, answering: false, thinking: true }, "thinking"],
    [{ drafting: false, answering: true, thinking: true }, "answering"],
    [{ drafting: true, answering: true, thinking: true }, "working"],
    [{ working: true, drafting: false, answering: true, thinking: true }, "working"],
  ] as const)("maps overlapping activity %j to %s", (activity, expected) => {
    expect(presence.resolveOnePresenceState(activity)).toBe(expected);
  });
});
