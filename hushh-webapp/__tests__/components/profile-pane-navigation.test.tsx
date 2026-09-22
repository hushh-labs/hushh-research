// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProfileEdgeGesture } from "@/components/app-ui/app-profile-edge-gesture";
import { PROFILE_PANE_OPEN_EVENT } from "@/lib/navigation/profile-pane";

const navigation = vi.hoisted(() => ({ pathname: "/one" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

describe("Profile pane touch navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/one";
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-app-profile-edge-active");
  });

  it("opens from a broad leftward body swipe on the One surface", () => {
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    render(<AppProfileEdgeGesture enabled />);

    fireEvent.touchStart(document, {
      touches: [{ identifier: 1, clientX: 320, clientY: 160 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ identifier: 1, clientX: 180, clientY: 164 }],
      timeStamp: 100,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 1, clientX: 150, clientY: 164 }],
      timeStamp: 140,
    });

    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { source: "native_swipe" } }),
    );
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });

  it("leaves the touch default alone while tracking a horizontal swipe", () => {
    // The listeners are passive so the compositor never waits on them; an
    // axis-locked leftward swipe still drives the indicator and opens the
    // pane, but it must not cancel the browser's own touch handling.
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    render(<AppProfileEdgeGesture enabled />);

    fireEvent.touchStart(document, {
      touches: [{ identifier: 7, clientX: 320, clientY: 160 }],
      timeStamp: 0,
    });
    const move = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [
        { identifier: 7, clientX: 200, clientY: 162 } as unknown as Touch,
      ],
    });
    document.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(
      document.documentElement.getAttribute("data-app-profile-edge-active"),
    ).toBe("true");

    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 7, clientX: 150, clientY: 162 }],
      timeStamp: 140,
    });
    expect(opened).toHaveBeenCalled();
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });

  it("reserves the extreme-left back lane and yields to vertical scrolling", () => {
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    const view = render(<AppProfileEdgeGesture enabled />);

    fireEvent.touchStart(document, {
      touches: [{ identifier: 2, clientX: 20, clientY: 160 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ identifier: 2, clientX: 0, clientY: 164 }],
      timeStamp: 100,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 2, clientX: 0, clientY: 164 }],
      timeStamp: 140,
    });

    fireEvent.touchStart(document, {
      touches: [{ identifier: 3, clientX: 320, clientY: 160 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ identifier: 3, clientX: 318, clientY: 300 }],
      timeStamp: 100,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 3, clientX: 318, clientY: 340 }],
      timeStamp: 140,
    });

    expect(opened).not.toHaveBeenCalled();
    view.unmount();
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });

  it("does not attach the Profile opener to dedicated Profile routes", () => {
    navigation.pathname = "/one/profile/account";
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    render(<AppProfileEdgeGesture enabled />);

    fireEvent.touchStart(document, {
      touches: [{ identifier: 4, clientX: 320, clientY: 160 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ identifier: 4, clientX: 160, clientY: 164 }],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 4, clientX: 120, clientY: 164 }],
      timeStamp: 120,
    });

    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });

  it("leaves Finance and other One descendants to their own swipe surfaces", () => {
    navigation.pathname = "/one/finance";
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    const view = render(<AppProfileEdgeGesture enabled />);

    fireEvent.touchStart(document, {
      touches: [{ identifier: 5, clientX: 320, clientY: 160 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ identifier: 5, clientX: 160, clientY: 164 }],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 5, clientX: 120, clientY: 164 }],
      timeStamp: 120,
    });

    expect(opened).not.toHaveBeenCalled();
    view.unmount();
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });
});
