import { describe, expect, it, vi } from "vitest";

import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import {
  navigateTopShellBack,
  resolveTopShellBackAction,
} from "@/lib/navigation/top-shell-back";
import { registerBackLayer } from "@/lib/navigation/back-layers";

describe("top shell back action", () => {
  it.each(["payouts", "request-pricing"])("returns %s to Profile while retaining its Feed origin", (panel) => {
    expect(resolveTopShellBackAction({
      pathname: `/one/profile/${panel}`,
      searchParams: new URLSearchParams("from=%2Fone%2Ffeed&documentPayouts=done"),
      sectionOrigin: null,
    })?.href).toBe("/one/profile?from=%2Fone%2Ffeed");
  });

  it("keeps the original request when a setup panel returns through Profile", () => {
    const origin = "/one/consent?tab=pending&requestId=document_share_request%3A11111111-1111-4111-8111-111111111111&requestView=received";
    let href = `/one/profile/payouts?${new URLSearchParams({ from: origin })}`;
    for (let i = 0; i < 2; i++) {
      const url = new URL(href, "https://app.test");
      href = resolveTopShellBackAction({ pathname: url.pathname, searchParams: url.searchParams, sectionOrigin: null })!.href;
    }
    expect(href).toBe(origin);
  });

  it("consumes a non-dismissible top overlay before any feature or route parent", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("data-state", "open");
    overlay.addEventListener("keydown", event => event.preventDefault());
    document.body.appendChild(overlay);
    const feature = vi.fn(() => true);
    const release = registerBackLayer({ pathname: "/one/pkm", depth: 2, back: feature });
    const navigate = vi.fn();
    try {
      expect(navigateTopShellBack({ pathname: "/one/pkm", navigate })).toBe(true);
      expect(feature).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally { overlay.remove(); release(); }
  });

  it("unwinds the deepest current layer once and ignores other routes and stale query states", () => {
    const shallow = vi.fn(() => true);
    const deep = vi.fn(() => true);
    const stale = vi.fn(() => true);
    const releases = [
      registerBackLayer({ pathname: "/one/pkm", depth: 1, back: shallow }),
      registerBackLayer({ pathname: "/one/pkm", depth: 3, back: deep }),
      registerBackLayer({ pathname: "/one/location", depth: 100, back: stale }),
      registerBackLayer({ pathname: "/one/pkm", depth: 100, query: { action: "old" }, back: stale }),
    ];
    const navigate = vi.fn();
    try {
      navigateTopShellBack({ pathname: "/one/pkm", navigate });
      expect(deep).toHaveBeenCalledOnce();
      expect(shallow).not.toHaveBeenCalled();
      expect(stale).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally { releases.forEach(release => release()); }
    navigateTopShellBack({ pathname: "/one/pkm", navigate });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("preserves Profile origin through detail, panel, and root", () => {
    let href = "/one/profile/security/vault?from=%2Fone%2Flocation";
    const parents: string[] = [];
    for (let i = 0; i < 3; i++) {
      const url = new URL(href, "https://app.test");
      href = resolveTopShellBackAction({ pathname: url.pathname, searchParams: url.searchParams, sectionOrigin: null })!.href;
      parents.push(href);
    }
    expect(parents).toEqual(["/one/profile/security?from=%2Fone%2Flocation", "/one/profile?from=%2Fone%2Flocation", "/one/location"]);
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

  // Terms and Privacy used to bypass the app shell with a hand-made back chip.
  // They sit in the core shell now: its top bar, its Back, its breadcrumb.
  it.each([
    ["/terms", "Terms of Use"],
    ["/privacy", "Privacy Policy"],
  ])("gives %s the core top bar, with Back to sign-in", (pathname, title) => {
    expect(resolveTopShellRouteProfile(pathname).id).toBe("standard");
    expect(resolveTopShellBreadcrumb(pathname)?.items).toEqual([
      { label: "Legal" },
      { label: title },
    ]);
    expect(resolveTopShellBackAction({ pathname })).toEqual({
      href: "/login",
      mode: "push",
      transitionMode: "full",
    });
  });
});
