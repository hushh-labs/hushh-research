import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { beginRouteTransition, useRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { useProfilePanePresentation } from "@/lib/navigation/use-profile-pane-presentation";
import { openProfilePane, pushProfilePaneLocation, profilePanelParentForPresentation,
  getProfilePaneHistoryDepth, popProfilePaneLocation, resolveProfilePaneUrlState } from "@/lib/navigation/profile-pane";
import { changeProfilePaneConnector } from "@/lib/navigation/profile-pane-back";

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

it("unwinds repeated retained connector visits before returning to Profile", async () => {
  window.history.replaceState(null, "", "/one");
  openProfilePane("/one", window.location.search);
  pushProfilePaneLocation("/one", window.location.search, { panel: "connectors", detail: null });
  const query = () => new URLSearchParams(window.location.search);
  const waitForBack = () => new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
  for (const id of ["gmail", "instagram", "google_drive"]) {
    changeProfilePaneConnector("/one", query(), id);
    expect(resolveProfilePaneUrlState(query()).location.detail).toBe(`connector:${id}`);
    const returned = waitForBack();
    changeProfilePaneConnector("/one", query(), null);
    await returned;
    expect(resolveProfilePaneUrlState(query()).location).toEqual({ panel: "connectors", detail: null });
    expect(getProfilePaneHistoryDepth()).toBe(2);
  }
  const returned = waitForBack();
  popProfilePaneLocation("/one", query());
  await returned;
  expect(resolveProfilePaneUrlState(query()).location).toEqual({ panel: null, detail: null });
  expect(getProfilePaneHistoryDepth()).toBe(1);
});

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

it("resolves View Transition updateCallback synchronously on pathname commit even while requestAnimationFrame is suppressed", async () => {
  vi.useFakeTimers();
  const originalRaf = window.requestAnimationFrame;
  // Simulate Chromium/WebKit rendering suppression while startViewTransition awaits updateCallback:
  // requestAnimationFrame NEVER fires until updateCallback's returned Promise resolves!
  window.requestAnimationFrame = vi.fn(() => 1);
  const doc = document as Document & {
    startViewTransition?: (update: () => void | Promise<void>) => {
      ready: Promise<void>;
      finished: Promise<void>;
      skipTransition: () => void;
    };
  };
  const originalStartVt = doc.startViewTransition;
  let updateSettled = false;
  doc.startViewTransition = vi.fn((update) => {
    const maybePromise = update();
    void Promise.resolve(maybePromise).then(() => {
      updateSettled = true;
    });
    return {
      ready: Promise.resolve(),
      finished: Promise.resolve(),
      skipTransition: vi.fn(),
    };
  });

  try {
    window.history.replaceState(null, "", "/one");
    navigation.pathname = "/one";
    navigation.query = "";
    const view = renderHook(() => useRouteTransition());

    act(() => {
      beginRouteTransition(
        "/one/pkm",
        () => {
          navigation.pathname = "/one/pkm";
        },
        "tap",
        "full",
      );
      view.rerender();
    });
    await Promise.resolve();

    // Must settle immediately on DOM commit without advancing timers or firing rAF!
    expect(updateSettled).toBe(true);
    expect(document.documentElement.dataset.routeTransition).toBe("idle");
    view.unmount();
  } finally {
    window.requestAnimationFrame = originalRaf;
    doc.startViewTransition = originalStartVt;
    vi.useRealTimers();
  }
});
