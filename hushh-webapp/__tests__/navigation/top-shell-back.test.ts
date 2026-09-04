import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  navigateTopShellBack,
  resolveTopShellBackAction,
} from "@/lib/navigation/top-shell-back";
import {
  clearTabSwitchHistory,
  recordTabSelection,
} from "@/lib/navigation/tab-switch-history";

describe("top shell back action", () => {
  beforeEach(() => {
    clearTabSwitchHistory();
  });

  it("uses the authored route parent instead of browser history", () => {
    expect(resolveTopShellBackAction({ pathname: "/ria/onboarding" })).toEqual({
      href: "/one",
      mode: "push",
      transitionMode: "full",
    });
  });

  it("uses replace for in-place profile and Location flows", () => {
    expect(
      resolveTopShellBackAction({
        pathname: "/one/profile",
        searchParams: new URLSearchParams("panel=security"),
      }),
    ).toMatchObject({ mode: "replace" });
    expect(
      resolveTopShellBackAction({
        pathname: "/one/location",
        searchParams: new URLSearchParams("action=share"),
      }),
    ).toMatchObject({ mode: "replace" });
  });

  it("returns the profile root to its tagged origin with a push (not replace)", () => {
    // Opening Profile from Location tags ?from=/one/location. Back from the
    // bare profile root pushes to that origin — the reported "back jumps to the
    // dashboard" glitch. No panel/detail is open, so it's a push, not a replace.
    const action = resolveTopShellBackAction({
      pathname: "/one/profile",
      searchParams: new URLSearchParams("from=/one/location"),
    });
    expect(action).toEqual({
      href: "/one/location",
      mode: "push",
      transitionMode: "full",
    });

    // No origin → historic default (One dashboard).
    expect(
      resolveTopShellBackAction({ pathname: "/one/profile" }),
    ).toEqual({ href: "/one", mode: "push", transitionMode: "full" });
  });

  it("returns a Connect-opened person profile directly to Connect", () => {
    expect(
      resolveTopShellBackAction({
        pathname: "/people/person-ref-scoped",
        searchParams: new URLSearchParams("from=/one/connect"),
      }),
    ).toEqual({
      href: "/one/connect",
      mode: "push",
      transitionMode: "full",
    });
  });

  it("returns the resolved action to the shared transition owner", () => {
    const navigate = vi.fn();
    expect(
      navigateTopShellBack({
        pathname: "/one/location",
        searchParams: new URLSearchParams("action=share"),
        navigate,
      }),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith({
      href: "/one/location?view=now",
      mode: "replace",
      transitionMode: "contextual",
    });
  });

  it("commits a same-screen back in place and only crossfades a real screen change", () => {
    // Every Location flow closes back onto /one/location — the same screen with
    // a different query. Crossfading it cost a 300ms exit beat before the
    // router was called, and any navigation arriving inside that window
    // superseded the back and dropped it.
    expect(
      resolveTopShellBackAction({
        pathname: "/one/location",
        searchParams: new URLSearchParams("action=needs-review"),
      }),
    ).toMatchObject({
      href: "/one/location?view=now",
      transitionMode: "contextual",
    });

    expect(
      resolveTopShellBackAction({
        pathname: "/one/profile",
        searchParams: new URLSearchParams("panel=security"),
      }),
    ).toMatchObject({ href: "/one/profile", transitionMode: "contextual" });

    // Your Map is a different route, so it keeps the full crossfade.
    expect(
      resolveTopShellBackAction({ pathname: "/one/location/map" }),
    ).toMatchObject({ href: "/one/location", transitionMode: "full" });
  });

  describe("Location tab siblings (same gap as RIA, #6286)", () => {
    // Now/People/Links are one route with a ?view= query, not a hierarchy,
    // so every one of them reads as the section root -- back tried to LEAVE
    // Location instead of undoing a tab switch. Same fix, applied here too.

    it("retraces People to Links when that is the recorded prior tab", () => {
      recordTabSelection("location", "/one/location?view=links");
      recordTabSelection("location", "/one/location?view=people");

      expect(
        resolveTopShellBackAction({
          pathname: "/one/location",
          searchParams: new URLSearchParams("view=people"),
        }),
      ).toMatchObject({
        href: "/one/location?view=links",
        mode: "replace",
        transitionMode: "contextual",
      });
    });

    it("retraces to the bare Now tab, not a ?view=now href", () => {
      // The registry's own href for Now is bare /one/location, matching
      // what TopShellTabs records -- a retrace target of "/one/location"
      // must not be treated as a miss just because it carries no query.
      recordTabSelection("location", "/one/location");
      recordTabSelection("location", "/one/location?view=people");

      expect(
        resolveTopShellBackAction({
          pathname: "/one/location",
          searchParams: new URLSearchParams("view=people"),
        }),
      ).toMatchObject({ href: "/one/location", mode: "replace" });
    });

    it("falls through to leaving the section with no recorded prior tab", () => {
      // A fresh arrival on People (deep link, cold start) has nothing to
      // undo, so back keeps its original section-leaving behavior.
      const action = resolveTopShellBackAction({
        pathname: "/one/location",
        searchParams: new URLSearchParams("view=people"),
      });
      expect(action).not.toBeNull();
      expect(action?.href).not.toBe("/one/location?view=people");
    });

    it("does not retrace to itself when the only record is the current tab", () => {
      recordTabSelection("location", "/one/location?view=people");
      recordTabSelection("location", "/one/location?view=people");

      const action = resolveTopShellBackAction({
        pathname: "/one/location",
        searchParams: new URLSearchParams("view=people"),
      });
      expect(action?.href).not.toBe("/one/location?view=people");
    });

    it("still closes an open flow in place, even with a tab switch recorded", () => {
      // ?action= owns its own close-in-place target (back to the tab the
      // flow was opened from); a merely-recorded sibling tab must not
      // override that.
      recordTabSelection("location", "/one/location?view=links");
      recordTabSelection("location", "/one/location?view=people");

      expect(
        resolveTopShellBackAction({
          pathname: "/one/location",
          searchParams: new URLSearchParams("action=share&view=people"),
        }),
      ).toMatchObject({
        href: "/one/location?view=people",
        mode: "replace",
      });
    });
  });
});
