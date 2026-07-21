import { afterEach, describe, expect, it, vi } from "vitest";

import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

describe("route transition intent ownership", () => {
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete document.documentElement.dataset.routeTransition;
  });

  it("commits only the latest target when taps arrive during the exit beat", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();

    beginRouteTransition("/one", first, "tap");
    vi.advanceTimersByTime(120);
    beginRouteTransition("/one/kai", second, "tap");
    vi.advanceTimersByTime(120);
    beginRouteTransition("/one/profile", third, "tap");

    vi.advanceTimersByTime(299);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate target requests instead of scheduling a second commit", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    beginRouteTransition("/one/kai", navigate, "tap");
    beginRouteTransition("/one/kai", navigate, "tap");
    vi.advanceTimersByTime(300);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps the outgoing surface hidden until the new route has settled", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    beginRouteTransition("/one/kai", navigate, "tap");
    vi.advanceTimersByTime(300);
    expect(navigate).toHaveBeenCalledTimes(1);

    // A route may take longer than the exit beat to resolve. The old surface
    // must not be replayed by a fixed timer while React/Next mounts the new
    // one; the route-key effect is the sole owner of the enter state.
    vi.advanceTimersByTime(500);
    expect(document.documentElement.dataset.routeTransition).toBe("pending");
  });

  it("commits contextual query selections immediately without a crossfade", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    beginRouteTransition(
      "/one/kai?tab=portfolio",
      navigate,
      "tap",
      "contextual",
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.routeTransition).not.toBe("pending");
  });
});
