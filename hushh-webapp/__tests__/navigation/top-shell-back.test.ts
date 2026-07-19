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

  it("executes the same explicit navigation contract as the top bar", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    expect(
      navigateTopShellBack({
        router,
        pathname: "/one/location",
        searchParams: new URLSearchParams("action=share"),
      }),
    ).toBe(true);
    expect(router.replace).toHaveBeenCalledWith("/one/location", {
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
  });
});
