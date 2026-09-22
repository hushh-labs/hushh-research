import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KeyboardHandler = (info: { keyboardHeight?: number }) => void;
const handlers = new Map<string, KeyboardHandler>();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
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
    handlers.clear();
    document.documentElement.style.removeProperty("--kb-height");
    document.documentElement.classList.remove("kb-open");
  });

  afterEach(() => {
    setInnerHeight(768);
  });

  it("publishes the whole keyboard when the web view keeps its size (iOS)", async () => {
    setInnerHeight(844);
    await mount();
    act(() => handlers.get("keyboardWillShow")?.({ keyboardHeight: 336 }));
    expect(inset()).toBe("336px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
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
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);
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
  });
});
