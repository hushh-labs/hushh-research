import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { useProfilePanePresentation } from "@/lib/navigation/use-profile-pane-presentation";
import { openProfilePane, pushProfilePaneLocation, profilePanelParentForPresentation } from "@/lib/navigation/profile-pane";

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

it("never combines a pending Next child route with the popped entry's native ancestry", () => {
  window.history.replaceState(null, "", "/one");
  openProfilePane("/one", window.location.search);
  pushProfilePaneLocation("/one", window.location.search, { panel: "preferences", detail: null });
  const parent = { state: window.history.state, href: window.location.href };
  pushProfilePaneLocation("/one", window.location.search, { panel: "preferences", detail: "voice" });
  navigation.query = window.location.search;
  const observed: string[][] = [];
  const view = renderHook(() => {
    const snapshot = useProfilePanePresentation();
    if (!snapshot) return null;
    const { panel, detail } = snapshot.location;
    const ancestry = profilePanelParentForPresentation("preferences", snapshot.history);
    const path = detail === "voice" ? [...(ancestry ? ["preferences"] : []), "voice"] : panel ? [panel] : [];
    observed.push(path);
    return snapshot;
  });
  expect(observed.at(-1)).toEqual(["preferences", "voice"]);
  const childSnapshot = view.result.current!;
  act(() => {
    // Browser Back updates the entry synchronously; Next may render its old
    // query again before committing the destination. Streaming/theme updates
    // during that gap must not manufacture an intermediate native path.
    window.history.replaceState(parent.state, "", parent.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: parent.state }));
  });
  view.rerender();
  expect(observed.at(-1)).toEqual(["preferences"]);
  expect(observed).not.toContainEqual(["voice"]);
  expect(view.result.current?.searchParams.get("profile_detail")).toBeNull();
  // Already committed callbacks retain ancestry from their own entry, not a
  // mutable history read. This snapshot is presentation metadata, not Back authority.
  expect(profilePanelParentForPresentation("preferences", childSnapshot.history)).toBe(true);
  navigation.query = window.location.search;
  view.rerender();
  expect(observed.at(-1)).toEqual(["preferences"]);
  view.unmount();
  window.history.replaceState(null, "", "/one");
  navigation.query = "";
});

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
