import { describe, expect, it, vi } from "vitest";

import {
  assignWindowLocation,
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  normalizeInternalAppNavigationHref,
  requestInternalAppNavigation,
} from "@/lib/utils/browser-navigation";
import { ROUTES } from "@/lib/navigation/routes";

describe("browser navigation utilities", () => {
  it("normalizes internal and same-origin hrefs for Next routed navigation", () => {
    expect(normalizeInternalAppNavigationHref(ROUTES.KAI_ANALYSIS)).toBe(
      ROUTES.KAI_ANALYSIS,
    );
    expect(
      normalizeInternalAppNavigationHref(
        `${window.location.origin}${ROUTES.KAI_ANALYSIS}?focus=active`,
      ),
    ).toBe(`${ROUTES.KAI_ANALYSIS}?focus=active`);
  });

  it("rejects protocol-relative and external hrefs as internal app navigation", () => {
    expect(normalizeInternalAppNavigationHref("//evil.example/one")).toBeNull();
    expect(normalizeInternalAppNavigationHref("https://example.com/one")).toBeNull();
    expect(normalizeInternalAppNavigationHref("/api/kai/analysis/run")).toBeNull();
    expect(normalizeInternalAppNavigationHref("/templates/ria-picks-template.csv")).toBeNull();
    expect(requestInternalAppNavigation({ href: "//evil.example/one" })).toBe(false);
  });

  it("routes internal assignWindowLocation calls through the app navigation event", () => {
    const received: Array<{ href: string; scroll?: boolean }> = [];
    const listener = (event: Event) => {
      received.push(
        (event as CustomEvent<{ href: string; scroll?: boolean }>).detail,
      );
    };
    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, listener);
    try {
      assignWindowLocation(`${ROUTES.KAI_ANALYSIS}?focus=active`);
    } finally {
      window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, listener);
    }

    expect(received).toEqual([
      { href: `${ROUTES.KAI_ANALYSIS}?focus=active`, scroll: false },
    ]);
  });
});
