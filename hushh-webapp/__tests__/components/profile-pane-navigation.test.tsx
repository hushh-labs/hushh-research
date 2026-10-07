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

  it.each(["/one", "/one/", "/one/index.html", "/"])("opens from a broad leftward body swipe on %s", (pathname) => {
    navigation.pathname = pathname;
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

    // The request also carries the shell's synchronous onResult answer.
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ source: "native_swipe" }),
      }),
    );
    window.removeEventListener(PROFILE_PANE_OPEN_EVENT, opened);
  });

  it("leaves the touch default alone while tracking a horizontal swipe", () => {
    // The listeners are passive so the compositor never waits on them; an
    // axis-locked leftward swipe still drives the indicator and opens the
    // pane, but it must not cancel the browser's own touch handling.
    const opened = vi.fn();
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    const registrations = vi.spyOn(window, "addEventListener");
    const view = render(<AppProfileEdgeGesture enabled />);
    for (const name of ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend"]) {
      const listeners = registrations.mock.calls.filter(([type]) => type === name);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).toEqual([name, expect.any(Function),
        expect.objectContaining({ capture: true, passive: true })]);
    }
    for (const [name, , options] of registrations.mock.calls) {
      if (/^(pointer|touch)/.test(name)) expect(options).not.toEqual(expect.objectContaining({ passive: false }));
    }
    registrations.mockRestore();

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
    const cancellation = vi.spyOn(move, "preventDefault");
    document.dispatchEvent(move);
    expect(cancellation).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
    expect(
      document.documentElement.getAttribute("data-app-profile-edge-active"),
    ).toBe("true");

    fireEvent.touchEnd(document, {
      changedTouches: [{ identifier: 7, clientX: 150, clientY: 162 }],
      timeStamp: 140,
    });
    expect(opened).toHaveBeenCalled();
    view.unmount();
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

  it("opens from an admitted roster link drag without stealing its tap or a nested control", () => {
    const opened = vi.fn();
    const clicked = vi.fn((event: React.MouseEvent) => event.preventDefault());
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, opened);
    const view = render(<><AppProfileEdgeGesture enabled /><a data-profile-body-swipe="" href="/one/calendar" onClick={clicked}>Calendar<button type="button"><svg data-testid="nested-control" /></button></a></>);
    const link = view.getByText("Calendar");
    fireEvent.click(link);
    expect(clicked).toHaveBeenCalledTimes(1);
    clicked.mockClear();
    const swipe = (target: Element) => {
      fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 320, clientY: 160 }] });
      fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 150, clientY: 162 }] });
      fireEvent.touchEnd(target, { changedTouches: [{ identifier: 1, clientX: 140, clientY: 162 }] });
    };
    swipe(view.getByTestId("nested-control"));
    expect(opened).not.toHaveBeenCalled();
    swipe(link);
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(link, { detail: 1 });
    expect(clicked).not.toHaveBeenCalled();
    fireEvent.click(link, { detail: 0 }); // Keyboard activation is never consumed.
    expect(clicked).toHaveBeenCalledTimes(1);
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

  it.each(["/one/finance", "/one/finance/", "/one/finance/index.html"])("leaves %s to its own swipe surfaces", (pathname) => {
    navigation.pathname = pathname;
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
