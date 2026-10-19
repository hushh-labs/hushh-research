import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KeyboardHandler = (info: { keyboardHeight?: number }) => void;
const handlers = new Map<string, KeyboardHandler>();
const native = vi.hoisted(() => ({ platform: "android" }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => native.platform,
  },
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: (event: string, handler: KeyboardHandler) => {
      handlers.set(event, handler);
      return Promise.resolve({ remove: () => handlers.delete(event) });
    },
  },
}));

import { KeyboardInsetManager } from "@/components/keyboard-inset-manager";

function setInnerHeight(px: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: px });
}

async function mount() {
  render(<KeyboardInsetManager />);
  // The plugin is imported lazily; let its listeners register.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const inset = () => document.documentElement.style.getPropertyValue("--kb-height");

describe("KeyboardInsetManager on native", () => {
  beforeEach(() => {
    native.platform = "android";
    handlers.clear();
    document.documentElement.style.removeProperty("--kb-height");
    document.documentElement.classList.remove("kb-open", "kb-resizes");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setInnerHeight(768);
  });

  it.each(["hide", "focus", "detach", "inert", "unmount"])("cancels deferred form scrolling after %s invalidates its target", async (reason) => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++sequence, callback); return sequence;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const nextFrame = () => {
      const pending = [...frames.values()]; frames.clear();
      act(() => pending.forEach(callback => callback(0)));
    };
    const input = document.createElement("input");
    const scroll = vi.fn(); input.scrollIntoView = scroll;
    document.body.appendChild(input);
    try {
      await mount(); input.focus();
      act(() => handlers.get("keyboardWillShow")?.({ keyboardHeight: 336 }));
      nextFrame();
      if (reason === "hide") act(() => handlers.get("keyboardWillHide")?.({}));
      if (reason === "focus") input.blur();
      if (reason === "detach") input.remove();
      if (reason === "inert") input.setAttribute("inert", "");
      if (reason === "unmount") cleanup();
      nextFrame();
      expect(scroll).not.toHaveBeenCalled();
      if (reason !== "unmount") {
        // A fresh, connected focus still scrolls: the fix is not disabling
        // keyboard avoidance for normal-flow forms.
        input.removeAttribute("inert"); document.body.appendChild(input); input.focus();
        act(() => handlers.get("keyboardDidShow")?.({ keyboardHeight: 336 }));
        nextFrame(); nextFrame();
        expect(scroll).toHaveBeenCalledOnce();
      }
    } finally { input.remove(); }
  });

  it("publishes the whole keyboard when the web view keeps its size (iOS)", async () => {
    native.platform = "ios";
    setInnerHeight(844);
    await mount();
    act(() => handlers.get("keyboardWillShow")?.({ keyboardHeight: 336 }));
    expect(inset()).toBe("336px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
    expect(document.documentElement.classList.contains("kb-resizes")).toBe(false);
  });

  it.each(["rotation", "scene resize"])("does not count iOS %s as keyboard absorption", async (change) => {
    native.platform = "ios";
    setInnerHeight(1194);
    await mount();
    // Orientation can be published before its new window bounds. A shorter
    // scene window has no orientation event at all. Neither is keyboard resize.
    act(() => {
      if (change === "rotation") window.dispatchEvent(new Event("orientationchange"));
      setInnerHeight(834);
      window.dispatchEvent(new Event("resize"));
    });
    for (const event of ["keyboardWillShow", "keyboardDidShow"]) {
      act(() => handlers.get(event)?.({ keyboardHeight: 320 }));
      expect(inset()).toBe("320px");
      expect(document.documentElement.classList.contains("kb-open")).toBe(true);
      expect(document.documentElement.classList.contains("kb-resizes")).toBe(false);
    }
    // Resizing while the keyboard is already present must preserve the
    // plugin-reported overlap too; the fixed iOS WebView does not absorb it.
    act(() => {
      setInnerHeight(768);
      window.dispatchEvent(new Event("resize"));
    });
    expect(inset()).toBe("320px");
  });

  it("does not subtract the keyboard twice when the WebView already shrank for it (Android)", async () => {
    // The Galaxy S24 Ultra: 891 dp tall, the keyboard 384 dp, and the WebView
    // resized to 507 dp for it. The resize can land before the event.
    setInnerHeight(891);
    await mount();
    setInnerHeight(507);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    act(() => handlers.get("keyboardDidShow")?.({ keyboardHeight: 384 }));
    expect(inset()).toBe("0px");
    // The keyboard is still open: the launcher steps aside and focused fields
    // scroll into view on kb-open, and kb-resizes names this platform.
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
    expect(document.documentElement.classList.contains("kb-resizes")).toBe(true);
  });

  it("corrects the inset when the resize lands after the keyboard event", async () => {
    setInnerHeight(891);
    await mount();
    act(() => handlers.get("keyboardWillShow")?.({ keyboardHeight: 384 }));
    expect(inset()).toBe("384px");
    setInnerHeight(507);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(inset()).toBe("0px");
  });

  it("keeps the part of the keyboard the resize did not absorb", async () => {
    setInnerHeight(891);
    await mount();
    setInnerHeight(600);
    act(() => handlers.get("keyboardDidShow")?.({ keyboardHeight: 384 }));
    expect(inset()).toBe("93px");
  });

  it("returns to zero on hide", async () => {
    setInnerHeight(844);
    await mount();
    act(() => handlers.get("keyboardWillShow")?.({ keyboardHeight: 336 }));
    act(() => handlers.get("keyboardWillHide")?.({}));
    expect(inset()).toBe("0px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);
    expect(document.documentElement.classList.contains("kb-resizes")).toBe(false);
  });
});
