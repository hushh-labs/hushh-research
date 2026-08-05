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
    expect(action).toEqual({ href: "/one/location", mode: "push" });

    // No origin → historic default (One dashboard).
    expect(
      resolveTopShellBackAction({ pathname: "/one/profile" }),
    ).toEqual({ href: "/one", mode: "push" });
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
      href: "/one/location",
      mode: "replace",
    });
  });
});
