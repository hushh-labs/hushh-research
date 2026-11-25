import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { beginRouteTransition, useRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

function RouteTransitionHarness() {
  useRouteTransition();
  return null;
}

describe("route transition History compatibility observer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete document.documentElement.dataset.routeTransition;
  });

  it("commits a cross-route replaceState synchronously instead of replaying it", () => {
    const view = render(<RouteTransitionHarness />);

    window.history.replaceState({ source: "next-router" }, "", "/one/setup");

    expect(window.location.pathname).toBe("/one/setup");
    expect(document.documentElement.dataset.routeTransition).toBe("pending");

    view.unmount();
  });

  it("releases the captured page on route commit while WebKit withholds animation frames", async () => {
    const settled = vi.fn();
    const original = Object.getOwnPropertyDescriptor(document, "startViewTransition");
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (update: () => Promise<void>) => {
        const ready = update().then(settled);
        return { ready, finished: ready, skipTransition: vi.fn() };
      },
    });
    const view = render(<RouteTransitionHarness />);
    try {
      const href = "/portfolio/shared";
      beginRouteTransition(href, () => window.history.pushState({}, "", href), "programmatic");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      view.rerender(<RouteTransitionHarness />);
      await Promise.resolve();
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      if (original) Object.defineProperty(document, "startViewTransition", original);
      else Reflect.deleteProperty(document, "startViewTransition");
    }
  });
});
