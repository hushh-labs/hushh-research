import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import { KeyboardInsetManager } from "@/components/keyboard-inset-manager";

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");

afterEach(() => {
  for (const [target, name, descriptor] of [
    [window, "matchMedia", originalMatchMedia],
    [window, "visualViewport", originalVisualViewport],
    [window, "innerHeight", originalInnerHeight],
    [navigator, "maxTouchPoints", originalTouchPoints],
  ] as const) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  }
  document.documentElement.style.removeProperty("--kb-visible-height");
  document.documentElement.style.removeProperty("--kb-visible-top");
});

describe("KeyboardInsetManager on iPhone web", () => {
  it("publishes the visual height once and clears it when the keyboard closes", () => {
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 844;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("coarse") || query.includes("820px") }),
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });

    const view = render(<KeyboardInsetManager />);
    act(() => {
      viewport.height = 500;
      viewport.offsetTop = 32;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement).toHaveClass("kb-open");
    expect(document.documentElement).not.toHaveClass("native-keyboard-inset");
    expect(document.documentElement.style.getPropertyValue("--kb-height")).toBe("312px");
    expect(document.documentElement.style.getPropertyValue("--kb-visible-height")).toBe("500px");
    expect(document.documentElement.style.getPropertyValue("--kb-visible-top")).toBe("32px");

    act(() => {
      viewport.height = 844;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement).not.toHaveClass("kb-open");
    expect(document.documentElement.style.getPropertyValue("--kb-visible-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--kb-visible-top")).toBe("");
    view.unmount();
  });
});
