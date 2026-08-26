import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeInternalAppNavigation,
  consumePendingInternalAppNavigation,
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  requestInternalAppNavigation,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

describe("pending internal app navigation", () => {
  beforeEach(() => {
    consumePendingInternalAppNavigation();
  });

  it("retains a cold-launch notification route until the router listener mounts", () => {
    const request = {
      href: "/one/feed",
      scroll: false,
      source: "programmatic" as const,
    };

    expect(requestInternalAppNavigation(request)).toBe(true);
    expect(consumePendingInternalAppNavigation()).toEqual(request);
    expect(consumePendingInternalAppNavigation()).toBeNull();
  });

  it("does not replay a request accepted synchronously by the mounted router", () => {
    const listener = vi.fn((event: Event) => {
      acknowledgeInternalAppNavigation(
        (event as CustomEvent<InternalAppNavigationRequest>).detail,
      );
    });
    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, listener);

    try {
      requestInternalAppNavigation({ href: "/one/feed", scroll: false });
    } finally {
      window.removeEventListener(
        INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
        listener,
      );
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(consumePendingInternalAppNavigation()).toBeNull();
  });

  it("keeps only the latest tap received during startup", () => {
    requestInternalAppNavigation({ href: "/one/feed?first=1" });
    requestInternalAppNavigation({ href: "/one/feed?latest=1" });

    expect(consumePendingInternalAppNavigation()).toMatchObject({
      href: "/one/feed?latest=1",
    });
  });
});
