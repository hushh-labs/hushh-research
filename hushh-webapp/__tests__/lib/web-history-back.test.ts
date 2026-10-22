// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decideWebHistoryBackCorrection,
  dismissProfileConfirmationOnBack,
  useWebHistoryBack,
  type RouteLocation,
} from "@/lib/navigation/web-history-back";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { ROUTES } from "@/lib/navigation/routes";

const capacitor = vi.hoisted(() => ({ native: false }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

function loc(pathname: string, search = ""): RouteLocation {
  return { pathname, search };
}

describe("confirmation above Profile", () => {
  function paneState(depth: number) {
    return { __hushhProfilePane: { depth, returnsToOrigin: true } };
  }
  function documentWithOverlay(role: "dialog" | "alertdialog") {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = `<div role="dialog" data-state="open"></div><div role="${role}" data-state="open"></div>`;
    return doc;
  }
  const previous = loc("/one", "?profile_pane=1&profile_panel=account");

  it("dismisses the frontmost confirmation before an Account-to-Profile Back", () => {
    const doc = documentWithOverlay("alertdialog");
    const cancel = vi.fn();
    doc.body.lastElementChild!.addEventListener("keydown", cancel);
    expect(dismissProfileConfirmationOnBack({
      previous, previousHistoryState: paneState(2), revealedHistoryState: paneState(1), doc,
    })).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0].key).toBe("Escape");
  });

  it("leaves Forward and ordinary Profile pane navigation to their history owner", () => {
    const doc = documentWithOverlay("alertdialog");
    const cancel = vi.fn();
    doc.body.lastElementChild!.addEventListener("keydown", cancel);
    expect(dismissProfileConfirmationOnBack({
      previous, previousHistoryState: paneState(1), revealedHistoryState: paneState(2), doc,
    })).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(dismissProfileConfirmationOnBack({
      previous, previousHistoryState: paneState(2), revealedHistoryState: paneState(1),
      doc: documentWithOverlay("dialog"),
    })).toBe(false);
  });

  it("honors a confirmation that refuses Escape without navigating the pane", () => {
    const doc = documentWithOverlay("alertdialog");
    doc.body.lastElementChild!.addEventListener("keydown", event => event.preventDefault());
    expect(dismissProfileConfirmationOnBack({
      previous, previousHistoryState: paneState(2), revealedHistoryState: null, doc,
    })).toBe(true);
    expect(doc.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
});

describe("decideWebHistoryBackCorrection (pure)", () => {
  it("does nothing with no prior location", () => {
    expect(decideWebHistoryBackCorrection(null, loc("/one"), vi.fn())).toBeNull();
  });

  it("does nothing when the resolver has no back action (app root / hideBack)", () => {
    const navigate = vi.fn().mockReturnValue(false);
    expect(
      decideWebHistoryBackCorrection(loc(ROUTES.ONE_HOME), loc("/anything"), navigate),
    ).toBeNull();
  });

  it("does nothing when the browser already revealed what the contract says", () => {
    const navigate = vi.fn((params: { navigate: (a: unknown) => void }) => {
      params.navigate({ href: ROUTES.ONE_LOCATION, mode: "push", transitionMode: "full" });
      return true;
    });
    expect(
      decideWebHistoryBackCorrection(
        loc(ROUTES.ONE_LOCATION_MAP),
        loc(ROUTES.ONE_LOCATION),
        navigate as unknown as typeof navigateTopShellBack,
      ),
    ).toBeNull();
  });

  it("corrects to the resolver's target when the browser revealed something else", () => {
    const navigate = vi.fn((params: { navigate: (a: unknown) => void }) => {
      params.navigate({ href: ROUTES.ONE_LOCATION, mode: "replace", transitionMode: "contextual" });
      return true;
    });
    const correction = decideWebHistoryBackCorrection(
      loc(ROUTES.ONE_LOCATION, "?action=sos"),
      loc(ROUTES.ONE_HOME),
      navigate as unknown as typeof navigateTopShellBack,
    );
    // revealed (/one) differs from the target (/one/location), so this is a
    // real pathname change -- "full", not the resolver's own "contextual".
    expect(correction).toEqual({ href: ROUTES.ONE_LOCATION, transitionMode: "full" });
  });

  it("recomputes transitionMode against the revealed location, not the resolver's own guess", () => {
    // The resolver always computes "contextual" for a query-only replace flow
    // (its action() helper compares the target to the pre-pop pathname, which
    // for this exact bug class is always the same pathname) -- but the
    // revealed (browser-current) pathname is different, so this must become
    // "full", not pass the resolver's "contextual" straight through.
    const navigate = vi.fn((params: { navigate: (a: unknown) => void }) => {
      params.navigate({ href: `${ROUTES.ONE_LOCATION}?view=now`, mode: "replace", transitionMode: "contextual" });
      return true;
    });
    const correction = decideWebHistoryBackCorrection(
      loc(ROUTES.ONE_LOCATION, "?action=share"),
      loc(ROUTES.ONE_HOME),
      navigate as unknown as typeof navigateTopShellBack,
    );
    expect(correction).toEqual({ href: `${ROUTES.ONE_LOCATION}?view=now`, transitionMode: "full" });
  });

  it("undoes the pop (returns to `previous`) when an overlay/back-layer consumed it without naming a target", () => {
    const navigate = vi.fn().mockReturnValue(true); // handled=true, but `navigate` callback never invoked
    const correction = decideWebHistoryBackCorrection(
      loc(ROUTES.ONE_LOCATION, "?action=share"),
      loc(ROUTES.ONE_HOME),
      navigate as unknown as typeof navigateTopShellBack,
    );
    expect(correction).toEqual({
      href: `${ROUTES.ONE_LOCATION}?action=share`,
      transitionMode: "full",
    });
  });

  it("never corrects around Profile Pane, regardless of which side is pane-governed", () => {
    const navigate = vi.fn((params: { navigate: (a: unknown) => void }) => {
      params.navigate({ href: ROUTES.ONE_HOME, mode: "push", transitionMode: "full" });
      return true;
    });
    expect(
      decideWebHistoryBackCorrection(
        loc(ROUTES.PROFILE, "?panel=account"),
        loc(ROUTES.ONE_HOME),
        navigate as unknown as typeof navigateTopShellBack,
      ),
    ).toBeNull();
    expect(
      decideWebHistoryBackCorrection(
        loc(ROUTES.ONE_HOME),
        loc(ROUTES.PROFILE, "?detail=sharing"),
        navigate as unknown as typeof navigateTopShellBack,
      ),
    ).toBeNull();
    // The current pane is query-owned over /one. Its header Back uses real
    // history, and a shell correction here would close it instead of showing
    // the Profile home entry revealed behind Payouts.
    expect(
      decideWebHistoryBackCorrection(
        loc(ROUTES.ONE_HOME, "?profile_pane=1&profile_panel=payouts"),
        loc(ROUTES.ONE_HOME, "?profile_pane=1"),
        navigate as unknown as typeof navigateTopShellBack,
      ),
    ).toBeNull();
    expect(
      decideWebHistoryBackCorrection(
        loc(ROUTES.ONE_HOME),
        loc(ROUTES.ONE_HOME, "?profile_pane=1&profile_panel=payouts"),
        navigate as unknown as typeof navigateTopShellBack,
      ),
    ).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("decideWebHistoryBackCorrection against the real resolver", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["?view=people&action=share", `${ROUTES.ONE_LOCATION}?view=people`],
    ["?action=sos", `${ROUTES.ONE_LOCATION}?view=now`],
    ["?action=ask", `${ROUTES.ONE_LOCATION}?view=now`],
  ])(
    "fixes native back from the confirmed repro %s to land on Location, not the dashboard",
    (search, expectedHref) => {
      const correction = decideWebHistoryBackCorrection(
        loc(ROUTES.ONE_LOCATION, search),
        loc(ROUTES.ONE_HOME),
        navigateTopShellBack,
      );
      expect(correction?.href).toBe(expectedHref);
      expect(correction?.transitionMode).toBe("full");
    },
  );

  it("is a true no-op for an ordinary pushed route climbing its authored parent", () => {
    const correction = decideWebHistoryBackCorrection(
      loc(ROUTES.ONE_LOCATION_MAP),
      loc(ROUTES.ONE_LOCATION),
      navigateTopShellBack,
    );
    expect(correction).toBeNull();
  });
});

describe("useWebHistoryBack", () => {
  afterEach(() => {
    capacitor.native = false;
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("registers exactly one popstate listener on web, removed on unmount", () => {
    const registrations = vi.spyOn(window, "addEventListener");
    const removals = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useWebHistoryBack(ROUTES.ONE_LOCATION, ""));
    const listeners = registrations.mock.calls.filter(([type]) => type === "popstate");
    expect(listeners).toHaveLength(1);
    unmount();
    expect(removals.mock.calls.filter(([type]) => type === "popstate")).toHaveLength(1);
  });

  it("never registers a listener on native platforms", () => {
    capacitor.native = true;
    const registrations = vi.spyOn(window, "addEventListener");
    renderHook(() => useWebHistoryBack(ROUTES.ONE_LOCATION, ""));
    expect(registrations.mock.calls.filter(([type]) => type === "popstate")).toHaveLength(0);
  });

  it("ignores an untrusted popstate even when the location clearly mismatches", () => {
    // jsdom cannot produce a *trusted* popstate at all (not even its own
    // history.back() -- verified: isTrusted is always false there), so this
    // is the regression guard this environment can give: if the isTrusted
    // gate were ever removed, this exact scenario (a real resolvable
    // mismatch) would call requestInternalAppNavigation. It must not.
    window.history.replaceState(null, "", `${ROUTES.ONE_LOCATION}?action=sos`);
    renderHook(() => useWebHistoryBack(ROUTES.ONE_LOCATION, "?action=sos"));
    act(() => {
      window.history.replaceState(null, "", ROUTES.ONE_HOME);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(requestInternalAppNavigation).not.toHaveBeenCalled();
  });
});
