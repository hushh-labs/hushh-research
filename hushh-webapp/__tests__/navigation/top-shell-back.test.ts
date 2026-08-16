import { describe, expect, it, vi } from "vitest";

import {
  navigateTopShellBack,
  resolveTopShellBackAction,
} from "@/lib/navigation/top-shell-back";

describe("top shell back action", () => {
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
});
