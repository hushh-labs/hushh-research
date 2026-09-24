import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

const navigation = vi.hoisted(() => ({
  pathname: "/one",
  query: "",
  router: { push: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => navigation.router,
}));

it("does not replay the route enter when opening, drilling, or popping Profile", () => {
  const view = renderHook(() => useRouteTransition());
  for (const query of [
    "profile_pane=1",
    "profile_pane=1&profile_panel=preferences",
    "profile_pane=1",
    "",
  ]) {
    navigation.query = query;
    view.rerender();
    expect(document.documentElement.dataset.routeTransition).toBe("idle");
  }
  navigation.pathname = "/one/connect";
  view.rerender();
  expect(document.documentElement.dataset.routeTransition).toBe("entering");
  view.unmount();
});

it("lets a pending exit hold the new route for two frames before the enter beat", () => {
  vi.useFakeTimers();
  try {
    navigation.pathname = "/one";
    navigation.query = "";
    const view = renderHook(() => useRouteTransition());
    // A full navigation's exit beat leaves the shell held at opacity 0.
    document.documentElement.dataset.routeTransition = "pending";
    navigation.pathname = "/one/feed";
    view.rerender();
    // The incoming page takes its first style/layout/paint frame hidden.
    expect(document.documentElement.dataset.routeTransition).toBe("pending");
    vi.advanceTimersByTime(20);
    expect(document.documentElement.dataset.routeTransition).toBe("pending");
    vi.advanceTimersByTime(20);
    expect(document.documentElement.dataset.routeTransition).toBe("entering");
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
