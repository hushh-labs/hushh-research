import {
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  requestInternalAppNavigation,
} from "@/lib/utils/browser-navigation";

describe("requestInternalAppNavigation", () => {
  it("dispatches internal navigation detail and returns success", () => {
    // existing test...
  });

  it("uses default navigation options when optional flags are omitted", () => {
    const details: unknown[] = [];

    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, (event) => {
      details.push((event as CustomEvent).detail);
    });

    const result = requestInternalAppNavigation({
      href: "/one",
    });

    expect(result).toBe(true);
    expect(details).toEqual([
      {
        href: "/one",
      },
    ]);
  });
});