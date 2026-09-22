// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEdgeBackGesture } from "@/components/app-ui/app-edge-back-gesture";

const capacitor = vi.hoisted(() => ({ native: true, platform: "ios" }));
const navigation = vi.hoisted(() => ({ pathname: "/one/kai" }));
const backAction = vi.hoisted(() => ({
  resolve: vi.fn(() => ({ href: "/one", mode: "push", transitionMode: "full" })),
  navigate: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => capacitor.platform,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/navigation/top-shell-back", () => ({
  resolveTopShellBackAction: (...args: unknown[]) => backAction.resolve(...args),
  navigateTopShellBack: (...args: unknown[]) => backAction.navigate(...args),
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

function touch(id: number, x: number, y: number) {
  return { identifier: id, clientX: x, clientY: y } as unknown as Touch;
}

describe("AppEdgeBackGesture", () => {
  beforeEach(() => {
    capacitor.native = true;
    capacitor.platform = "ios";
    backAction.navigate.mockClear();
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-app-edge-back-active");
  });

  it("commits a rightward edge swipe without cancelling the touch default", () => {
    render(<AppEdgeBackGesture />);

    fireEvent.touchStart(document, {
      touches: [touch(1, 12, 300)],
      timeStamp: 0,
    });

    // Passive listeners: the move must never be default-prevented, because a
    // non-passive touchmove on `window` makes WebKit wait for the main thread
    // on every scroll in the app, not only on edge swipes.
    const move = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touch(1, 60, 304)],
    });
    document.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(document.documentElement.dataset.appEdgeBackActive).toBe("true");

    fireEvent.touchEnd(document, {
      changedTouches: [touch(1, 96, 306)],
      timeStamp: 120,
    });

    expect(backAction.navigate).toHaveBeenCalledTimes(1);
  });

  it("ignores a touch that starts outside the 28px edge lane", () => {
    render(<AppEdgeBackGesture />);

    fireEvent.touchStart(document, {
      touches: [touch(2, 120, 300)],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [touch(2, 240, 300)],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [touch(2, 240, 300)],
      timeStamp: 120,
    });

    expect(backAction.navigate).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.appEdgeBackActive).not.toBe("true");
  });

  it("yields to a vertical drag that begins in the edge lane", () => {
    render(<AppEdgeBackGesture />);

    fireEvent.touchStart(document, {
      touches: [touch(3, 10, 300)],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [touch(3, 14, 340)],
      timeStamp: 60,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [touch(3, 20, 420)],
      timeStamp: 140,
    });

    expect(backAction.navigate).not.toHaveBeenCalled();
  });

  it("does nothing off native iOS", () => {
    capacitor.native = false;
    render(<AppEdgeBackGesture />);

    fireEvent.touchStart(document, {
      touches: [touch(4, 12, 300)],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [touch(4, 90, 302)],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [touch(4, 110, 302)],
      timeStamp: 120,
    });

    expect(backAction.navigate).not.toHaveBeenCalled();
  });
});
