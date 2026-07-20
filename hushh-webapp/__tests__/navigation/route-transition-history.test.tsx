import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

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
});
