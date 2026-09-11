/**
 * Chrome that is hidden must not still be fetching.
 *
 * WHY THIS EXISTS
 * `useSessionChromeSuppression` hides the persistent nav before paint while a
 * route verifies session state. It does that by toggling a DOM attribute, and
 * every component beneath it stays mounted and keeps issuing requests. So a
 * brand-new person waiting on the setup gate was also paying for a consent
 * badge, a feed badge, an avatar image, and a persona read -- against a
 * connection pool of four, where `/api/consent/center/summary` was measured at
 * 125,614 ms. Hiding was doing no work; only stopping the fetch does.
 *
 * The design intent existed. The wiring did not, and nothing could tell: the
 * screen looked exactly the same either way. These pin the wiring.
 */

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";

import {
  useSessionChromeSuppressed,
  useSessionChromeSuppression,
  __resetSessionChromeSuppressionForTests,
} from "@/lib/auth/use-session-chrome-suppression";

describe("session chrome suppression is observable, not just visual", () => {
  beforeEach(() => {
    __resetSessionChromeSuppressionForTests();
  });

  it("reports not-suppressed when no guard is deciding", () => {
    const { result } = renderHook(() => useSessionChromeSuppressed());
    expect(result.current).toBe(false);
  });

  it("reports suppressed while a guard holds a token", () => {
    const { result } = renderHook(() => {
      useSessionChromeSuppression(true);
      return useSessionChromeSuppressed();
    });
    expect(result.current).toBe(true);
  });

  it("a consumer that is NOT the suppressing component still sees it", () => {
    // The whole reason this is module-level rather than React context: every
    // consumer (Navbar, the top bar, the persona provider) sits ABOVE the guard
    // in the tree, so no context could ever reach them.
    const consumer = renderHook(() => useSessionChromeSuppressed());
    expect(consumer.result.current).toBe(false);

    const guard = renderHook(() => useSessionChromeSuppression(true));
    expect(consumer.result.current).toBe(true);

    act(() => guard.unmount());
    expect(consumer.result.current).toBe(false);
  });

  it("stays suppressed while ANY guard is still deciding", () => {
    // Two guards mount in one commit on a real first paint. The first to finish
    // must not un-suppress the chrome for the one still working.
    const consumer = renderHook(() => useSessionChromeSuppressed());
    const first = renderHook(() => useSessionChromeSuppression(true));
    const second = renderHook(() => useSessionChromeSuppression(true));
    expect(consumer.result.current).toBe(true);

    act(() => first.unmount());
    expect(consumer.result.current).toBe(true);

    act(() => second.unmount());
    expect(consumer.result.current).toBe(false);
  });

  it("keeps the DOM attribute and the hook telling the same story", () => {
    // Two readers of one fact drift apart the moment they are updated in
    // different places. They are updated together, and this says so.
    const consumer = renderHook(() => useSessionChromeSuppressed());
    const guard = renderHook(() => useSessionChromeSuppression(true));
    expect(document.documentElement.hasAttribute("data-session-check-active")).toBe(true);
    expect(consumer.result.current).toBe(true);

    act(() => guard.unmount());
    expect(document.documentElement.hasAttribute("data-session-check-active")).toBe(false);
    expect(consumer.result.current).toBe(false);
  });
});

describe("the badge hooks accept an enabled gate", () => {
  // Asserted against the source rather than by rendering, because rendering
  // either hook drags in auth, cache, and persona providers -- and the property
  // under test is one line each. A gate that silently disappears is the failure
  // mode; a gate that is present but mis-wired is caught by the Navbar case
  // below.
  it("useConsentPendingSummaryCount can be switched off", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/consent/use-consent-pending-summary-count.ts", "utf8"),
    );
    expect(src).toContain("options?: { enabled?: boolean }");
    expect(src).toContain("(options?.enabled ?? true)");
  });

  it("useFeedUnreadCount can be switched off", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/feed/use-feed-unread-count.ts", "utf8"),
    );
    expect(src).toContain("options?: { enabled?: boolean }");
    expect(src).toContain("!user?.uid || !enabled");
  });

  it("the Navbar switches both off while the shell is still deciding", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("components/navbar.tsx", "utf8"),
    );
    // Route AND suppression. The route clause alone measured no effect: across
    // the post-login redirect the app renders the setup hub while `pathname` is
    // still `/login`, so a route check is blind for exactly the window where the
    // pool is contended.
    expect(src).toContain("!useOnboardingChrome && !chromeSuppressed");
    expect(src).toContain("useConsentPendingSummaryCount({ enabled: badgesAreVisible })");
    expect(src).toContain("useFeedUnreadCount({ enabled: badgesAreVisible })");
  });

  it("the avatar does not fetch an image nobody is looking at", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("components/app-ui/top-app-bar.tsx", "utf8"),
    );
    expect(src).toContain("fetchWhenCold:");
    expect(src).toContain("!chromeSuppressed");
  });
});
