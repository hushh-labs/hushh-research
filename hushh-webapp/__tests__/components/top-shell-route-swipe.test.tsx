/** @vitest-environment jsdom */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TopShellRouteSwipe } from "@/components/app-ui/top-shell-route-swipe";
import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  begin: vi.fn((_href: string, navigate: () => void) => navigate()),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/one/consent",
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("@/lib/morphy-ux/hooks/use-route-transition", () => ({
  beginRouteTransition: navigation.begin,
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

describe("TopShellRouteSwipe", () => {
  beforeEach(() => {
    navigation.begin.mockClear();
    navigation.push.mockClear();
    document.documentElement.style.removeProperty(
      "--top-shell-tab-swipe-consent-position",
    );
  });

  it("tracks Consent swipe progress and commits the adjacent contextual tab", async () => {
    const view = render(
      <TopShellRouteSwipe tabSet={CONSENT_TABS}>
        <div>Consent content</div>
      </TopShellRouteSwipe>,
    );
    const surface = view.container.querySelector<HTMLElement>(
      "[data-top-shell-route-swipe-content='true']",
    );
    expect(surface).not.toBeNull();

    fireEvent.touchStart(document, {
      touches: [{ clientX: 320, clientY: 120 }],
      timeStamp: 0,
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 180, clientY: 122 }],
      timeStamp: 100,
    });

    expect(surface?.style.transform).toBe("translate3d(-25.2px, 0, 0)");
    expect(
      Number(
        document.documentElement.style.getPropertyValue(
          "--top-shell-tab-swipe-consent-position",
        ),
      ),
    ).toBeGreaterThan(0);

    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 160, clientY: 122 }],
      timeStamp: 140,
    });

    await waitFor(() => {
      expect(navigation.begin).toHaveBeenCalledWith(
        "/one/consent?tab=active",
        expect.any(Function),
        "tap",
        "contextual",
      );
    });
    expect(navigation.push).toHaveBeenCalledWith(
      "/one/consent?tab=active",
      { scroll: false },
    );
  });
});
