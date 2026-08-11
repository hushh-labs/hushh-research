/** @vitest-environment jsdom */

import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TopShellRouteSwipe } from "@/components/app-ui/top-shell-route-swipe";
import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  begin: vi.fn(),
  pathname: "/one/consent",
  scrollToTop: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("@/lib/morphy-ux/hooks/use-route-transition", () => ({
  beginRouteTransition: navigation.begin,
}));

vi.mock("@/lib/navigation/use-scroll-reset", () => ({
  scrollAppToTop: navigation.scrollToTop,
}));

const CONSENT_TABS: TopShellTabSet = {
  id: "consent",
  label: "Consent Center",
  queryParam: "tab",
  activeValue: "requests",
  tabs: [
    {
      value: "requests",
      label: "Requests",
      href: "/one/consent?tab=requests",
    },
    { value: "active", label: "Active", href: "/one/consent?tab=active" },
    { value: "history", label: "History", href: "/one/consent?tab=history" },
  ],
};

const RIA_TABS: TopShellTabSet = {
  id: "ria",
  label: "RIA workspace",
  queryParam: null,
  activeValue: "profile",
  tabs: [
    { value: "profile", label: "Profile", href: "/ria/profile" },
    { value: "clients", label: "Clients", href: "/ria/clients" },
    { value: "picks", label: "Picks", href: "/ria/picks" },
  ],
};

describe("TopShellRouteSwipe", () => {
  beforeEach(() => {
    navigation.begin.mockClear();
    navigation.push.mockClear();
    navigation.scrollToTop.mockClear();
    navigation.pathname = "/one/consent";
    document.documentElement.style.removeProperty(
      "--top-shell-tab-swipe-consent-position",
    );
  });

  it("does not attach a route-hop swipe gesture for Consent - it owns an in-page SwipeViews pager instead", () => {
    // Consent used to be the one query-backed exception here. It now renders
    // its own SwipeViews inside the page body (like Finance/Location already
    // did), so this component must stay fully inert for it: no gesture
    // listeners, no wrapper element, and no navigation on drag.
    const view = render(
      <TopShellRouteSwipe tabSet={CONSENT_TABS}>
        <div>Consent content</div>
      </TopShellRouteSwipe>,
    );
    const surface = view.container.querySelector<HTMLElement>(
      "[data-top-shell-route-swipe-content='true']",
    );
    expect(surface).toBeNull();

    fireEvent.touchStart(document, {
      touches: [{ clientX: 320, clientY: 120 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 180, clientY: 122 }],
      timeStamp: 100,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 160, clientY: 122 }],
      timeStamp: 140,
    });

    expect(navigation.begin).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("keeps a committed RIA drag on the compositor until the shared route transition commits", () => {
    navigation.pathname = "/ria/profile";
    const view = render(
      <TopShellRouteSwipe tabSet={RIA_TABS}>
        <div>RIA profile content</div>
      </TopShellRouteSwipe>,
    );
    const surface = view.container.querySelector<HTMLElement>(
      "[data-top-shell-route-swipe-content='true']",
    );

    expect(surface).toHaveClass("touch-pan-y", "transform-gpu");

    fireEvent.touchStart(document, {
      touches: [{ clientX: 320, clientY: 120 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 160, clientY: 122 }],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 120, clientY: 122 }],
      timeStamp: 120,
    });

    expect(navigation.begin).toHaveBeenCalledWith(
      "/ria/clients",
      expect.any(Function),
      "tap",
      "full",
    );
    expect(surface?.style.transform).not.toBe("translate3d(0, 0, 0)");
    expect(navigation.scrollToTop).not.toHaveBeenCalled();

    const navigate = navigation.begin.mock.calls[0]?.[1] as (() => void) | undefined;
    navigate?.();

    expect(navigation.scrollToTop).toHaveBeenCalledWith("auto");
    expect(navigation.push).toHaveBeenCalledWith("/ria/clients", {
      scroll: false,
    });
    expect(surface?.style.transform).toBe("translate3d(0, 0, 0)");
  });

  it("does not navigate beyond the first RIA tab", () => {
    navigation.pathname = "/ria/profile";
    render(
      <TopShellRouteSwipe tabSet={RIA_TABS}>
        <div>RIA profile content</div>
      </TopShellRouteSwipe>,
    );

    fireEvent.touchStart(document, {
      touches: [{ clientX: 100, clientY: 120 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 260, clientY: 122 }],
      timeStamp: 80,
    });
    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 300, clientY: 122 }],
      timeStamp: 120,
    });

    expect(navigation.begin).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
