/**
 * Back must never become permanently dead.
 *
 * Reported from One Location: "Share location, Your Map, Active shares, Shared
 * with me, Needs my review, Request location, Settings — every one of them is
 * very hard to go back from. I keep clicking and nothing happens."
 *
 * The cause was not in any Location screen. Two shared pieces of navigation
 * machinery could each latch:
 *
 *   1. The interaction coordinator folds a repeat request for the same
 *      destination into the one already in flight. A navigation only clears
 *      itself when the app reports the new route settled, and that report is
 *      easy to miss — so the record stayed active and swallowed every later
 *      tap to the same destination, forever.
 *
 *   2. `data-route-transition="pending"` holds the whole app shell at
 *      opacity 0 while a page exits. A contextual commit (the Location hub's
 *      Now / People / Links tabs) cleared every timer that would have restored
 *      it without restoring it itself.
 *
 * These tests drive the real modules. They are the regression fence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

const routerReplace = vi.fn();
const routerPush = vi.fn();
// Next hands back a stable router instance. A fresh object per render would
// tear down the hook's effect and cancel the intent on every rerender, which
// would hide exactly the latch these tests exist to catch.
const stableRouter = { replace: routerReplace, push: routerPush };
let currentPathname = "/one/location";
let currentSearch = new URLSearchParams("");

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useSearchParams: () => currentSearch,
  useRouter: () => stableRouter,
}));

import {
  beginRouteTransition,
  useRouteTransition,
} from "@/lib/morphy-ux/hooks/use-route-transition";

function Harness() {
  useRouteTransition();
  return null;
}

describe("back navigation never latches", () => {
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    routerReplace.mockClear();
    routerPush.mockClear();
    delete document.documentElement.dataset.routeTransition;
  });

  it("answers a repeat back tap when the first one landed somewhere the target string did not predict", () => {
    vi.useFakeTimers();
    currentPathname = "/one/location";
    currentSearch = new URLSearchParams("action=needs-review");

    const { rerender } = render(<Harness />);

    // Back out of a Location flow. The hub's own effects rewrite the query as
    // it mounts, so the route the person lands on is not the bare target href.
    const firstBack = vi.fn(() => {
      currentSearch = new URLSearchParams("view=people");
    });
    act(() => {
      beginRouteTransition("/one/location", firstBack, "tap", "full");
      vi.advanceTimersByTime(300);
    });
    expect(firstBack).toHaveBeenCalledTimes(1);

    act(() => {
      rerender(<Harness />);
      vi.advanceTimersByTime(400);
    });

    // Press back again for the same destination. It must navigate.
    const secondBack = vi.fn();
    act(() => {
      beginRouteTransition("/one/location", secondBack, "tap", "full");
      vi.advanceTimersByTime(300);
    });
    expect(secondBack).toHaveBeenCalledTimes(1);
  });

  it("still folds a double tap into a single commit", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    beginRouteTransition("/one/kai", navigate, "tap");
    beginRouteTransition("/one/kai", navigate, "tap");
    vi.advanceTimersByTime(300);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps answering back after a navigation that never reports settling", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    act(() => {
      beginRouteTransition("/one/location", first, "tap", "full");
      vi.advanceTimersByTime(300);
    });
    expect(first).toHaveBeenCalledTimes(1);

    // No route ever resolves — nothing settles the navigation. A person who
    // presses back again must not be ignored.
    const retry = vi.fn();
    act(() => {
      vi.advanceTimersByTime(1_000);
      beginRouteTransition("/one/location", retry, "tap", "full");
      vi.advanceTimersByTime(300);
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("never leaves the app shell faded out when a tab switch interrupts an exit", () => {
    vi.useFakeTimers();
    document.documentElement.dataset.routeTransition = "idle";

    act(() => {
      beginRouteTransition("/one/location", vi.fn(), "tap", "full");
    });
    expect(document.documentElement.dataset.routeTransition).toBe("pending");

    // A Location hub tab (Now / People / Links) commits in place mid-exit.
    act(() => {
      beginRouteTransition(
        "/one/location?view=links",
        vi.fn(),
        "tap",
        "contextual",
      );
    });

    expect(document.documentElement.dataset.routeTransition).not.toBe(
      "pending",
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.documentElement.dataset.routeTransition).not.toBe(
      "pending",
    );
  });

  it("repairs an inherited pending exit when a contextual route resolves", () => {
    vi.useFakeTimers();
    currentPathname = "/one/location";
    currentSearch = new URLSearchParams("");
    const { rerender } = render(<Harness />);

    // A history-observed navigation latched the exit with no coordinator
    // intent behind it.
    document.documentElement.dataset.routeTransition = "pending";

    act(() => {
      beginRouteTransition(
        "/one/location?view=links",
        () => {
          currentSearch = new URLSearchParams("view=links");
        },
        "tap",
        "contextual",
      );
      rerender(<Harness />);
    });

    expect(document.documentElement.dataset.routeTransition).not.toBe(
      "pending",
    );
  });
});
