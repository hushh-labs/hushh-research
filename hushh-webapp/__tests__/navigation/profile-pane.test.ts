// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_PANE_DETAIL_QUERY,
  PROFILE_PANE_OPEN_EVENT,
  PROFILE_PANE_PANEL_QUERY,
  PROFILE_PANE_QUERY,
  buildConnectorSignInReturnHref,
  buildProfileConnectorsPaneHref,
  buildProfilePaneCloseHref,
  buildProfilePaneHref,
  canGoBackProfilePane,
  clearProfilePaneQuery,
  closeProfilePane,
  getProfilePaneHistoryDepth,
  legacyProfileRouteRedirectHref,
  popProfilePaneLocation,
  profileLegalLocation,
  profilePaneParentLocation,
  openProfilePane,
  pushProfilePaneLocation,
  replaceProfilePaneLocation,
  requestProfilePaneOpen,
  resolveProfilePaneUrlState,
  type ProfilePaneOpenDetail,
} from "@/lib/navigation/profile-pane";
import {
  buildProfileRoute,
  resolveProfileRouteState,
} from "@/lib/navigation/profile-routes";

const ACCOUNT = { panel: "account" as const, detail: null };
const PHONE = { panel: "account" as const, detail: "phone" as const };

function currentUrl() {
  return new URL(window.location.href);
}

describe("Profile pane navigation state", () => {
  beforeEach(() => {
    window.history.replaceState(
      null,
      "",
      "/one?view=people&location=shared&profile_pane=0",
    );
  });

  it("parses the typed root, panel, and detail location without losing unrelated query state", () => {
    const state = resolveProfilePaneUrlState(
      "view=people&location=shared&profile_pane=1&profile_panel=account&profile_detail=phone",
    );

    expect(state).toEqual({ open: true, location: PHONE });
    expect(canGoBackProfilePane(PHONE)).toBe(true);
    expect(canGoBackProfilePane({ panel: null, detail: null })).toBe(false);
    expect(profilePaneParentLocation(PHONE)).toEqual(ACCOUNT);
    expect(profilePaneParentLocation(ACCOUNT)).toEqual({
      panel: null,
      detail: null,
    });
  });

  it("addresses Connectors as a Profile section with a Back-able connector detail", () => {
    const drive = resolveProfilePaneUrlState(
      "profile_pane=1&profile_panel=connectors&profile_detail=connector:google_drive",
    );
    expect(drive).toEqual({
      open: true,
      location: { panel: "connectors", detail: "connector:google_drive" },
    });
    // The pane header's Back leaves the connector for the Connectors list.
    expect(profilePaneParentLocation(drive.location)).toEqual({
      panel: "connectors",
      detail: null,
    });
    // An address-bar value that is not a catalog id opens the list instead.
    expect(
      resolveProfilePaneUrlState(
        "profile_pane=1&profile_panel=connectors&profile_detail=connector:%3Cscript%3E",
      ).location,
    ).toEqual({ panel: "connectors", detail: null });

    expect(buildProfileConnectorsPaneHref()).toBe(
      "/one?profile_pane=1&profile_panel=connectors",
    );
    expect(buildProfileConnectorsPaneHref("gmail")).toBe(
      "/one?profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agmail",
    );

    // The legacy route (redirected into the pane) means the same place.
    expect(
      resolveProfileRouteState("/one/profile/connectors?connector=gmail"),
    ).toEqual({ panel: "connectors", detail: "connector:gmail" });
    expect(
      buildProfileRoute({ panel: "connectors", detail: "connector:gmail" }),
    ).toBe("/one/profile/connectors?connector=gmail");
  });

  it("lands every connector sign-in on Connectors in the pane, never a page", () => {
    // Started in Profile: the pane over One.
    expect(buildConnectorSignInReturnHref("connector_settings")).toBe(
      "/one?profile_pane=1&profile_panel=connectors",
    );
    // Started in chat: the pane over the chat, which restores its draft.
    expect(buildConnectorSignInReturnHref("chat")).toBe(
      "/?profile_pane=1&profile_panel=connectors",
    );
    for (const startedFrom of ["connector_settings", "chat"] as const) {
      const href = buildConnectorSignInReturnHref(startedFrom);
      expect(href).not.toContain("/one/profile/connectors");
      expect(href).not.toContain("panel=connectors&");
      expect(new URLSearchParams(href.split("?")[1]).get("panel")).toBeNull();
    }
  });

  it("reads Terms and Privacy in place in Profile's Legal section", () => {
    const terms = resolveProfilePaneUrlState(
      "profile_pane=1&profile_panel=legal&profile_detail=terms",
    );
    expect(terms).toEqual({ open: true, location: profileLegalLocation("terms") });
    // Back from a document lands on the Legal section, then Profile.
    expect(profilePaneParentLocation(terms.location)).toEqual({
      panel: "legal",
      detail: null,
    });
    expect(
      resolveProfilePaneUrlState(
        "profile_pane=1&profile_panel=legal&profile_detail=privacy",
      ).location,
    ).toEqual({ panel: "legal", detail: "privacy" });
    // Only the two documents are details of Legal.
    expect(
      resolveProfilePaneUrlState(
        "profile_pane=1&profile_panel=legal&profile_detail=delete-account",
      ).location,
    ).toEqual({ panel: "legal", detail: null });

    // A route-level caller (the native bundle's section pages) gets a Profile
    // address that redirects into the pane, never the public /terms page.
    const route = buildProfileRoute({ panel: "legal", detail: "privacy" });
    expect(route).toBe("/one/profile?panel=legal&detail=privacy");
    expect(resolveProfileRouteState(route)).toEqual({
      panel: "legal",
      detail: "privacy",
    });
    expect(
      legacyProfileRouteRedirectHref(new URLSearchParams(route.split("?")[1])),
    ).toBe("/one?profile_pane=1&profile_panel=legal&profile_detail=privacy");
  });

  it("builds pane URLs on the current route and preserves route-owned query parameters", () => {
    const href = buildProfilePaneHref(
      "/one/location",
      "view=people&location=shared",
      PHONE,
    );
    const url = new URL(href, window.location.origin);

    expect(url.pathname).toBe("/one/location");
    expect(url.searchParams.get("view")).toBe("people");
    expect(url.searchParams.get("location")).toBe("shared");
    expect(url.searchParams.get(PROFILE_PANE_QUERY)).toBe("1");
    expect(url.searchParams.get(PROFILE_PANE_PANEL_QUERY)).toBe("account");
    expect(url.searchParams.get(PROFILE_PANE_DETAIL_QUERY)).toBe("phone");
    expect(buildProfilePaneCloseHref(url.pathname, url.search)).toBe(
      "/one/location?view=people&location=shared",
    );
  });

  it("creates one browser history entry per open or recursive push", () => {
    openProfilePane("/one", window.location.search, {
      panel: null,
      detail: null,
    });
    expect(getProfilePaneHistoryDepth()).toBe(1);
    expect(currentUrl().searchParams.get(PROFILE_PANE_QUERY)).toBe("1");
    expect(currentUrl().searchParams.get("view")).toBe("people");

    pushProfilePaneLocation("/one", window.location.search, ACCOUNT);
    expect(getProfilePaneHistoryDepth()).toBe(2);
    expect(currentUrl().searchParams.get(PROFILE_PANE_PANEL_QUERY)).toBe(
      "account",
    );

    const back = vi.spyOn(window.history, "back");
    popProfilePaneLocation("/one", window.location.search);
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });

  it("pops a resumed child to its parent instead of closing the sheet", () => {
    openProfilePane("/one", window.location.search, ACCOUNT);
    popProfilePaneLocation("/one", window.location.search);
    expect(resolveProfilePaneUrlState(window.location.search)).toEqual({
      open: true, location: { panel: null, detail: null },
    });
    expect(currentUrl().searchParams.get("view")).toBe("people");
  });

  it("returns a detail opened from another screen to that screen, not its parent", () => {
    // Founder report: Puppy One's "Trusted devices" opened the right detail,
    // and Back then landed on Security, a screen the person never visited.
    const TRUSTED_DEVICES = {
      panel: "security" as const,
      detail: "trusted-devices" as const,
    };
    openProfilePane("/one", window.location.search, TRUSTED_DEVICES, {
      returnsToOrigin: true,
    });
    expect(resolveProfilePaneUrlState(window.location.search)).toEqual({
      open: true,
      location: TRUSTED_DEVICES,
    });

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    popProfilePaneLocation("/one", window.location.search);
    expect(back).toHaveBeenCalledOnce();
    // Not rewritten in place to the Security parent.
    expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(
      TRUSTED_DEVICES,
    );
    back.mockRestore();
  });

  it("keeps the origin through an in-place replace, and only on the first entry", () => {
    openProfilePane("/one", window.location.search, PHONE, {
      returnsToOrigin: true,
    });
    pushProfilePaneLocation("/one", window.location.search, ACCOUNT);
    expect(window.history.state.__hushhProfilePane).toEqual({ depth: 2 });

    window.history.replaceState(
      { __hushhProfilePane: { depth: 1, returnsToOrigin: true } },
      "",
      window.location.href,
    );
    replaceProfilePaneLocation("/one", window.location.search, ACCOUNT);
    expect(window.history.state.__hushhProfilePane).toEqual({
      depth: 1,
      returnsToOrigin: true,
    });
  });

  it("pops a direct detail through panel and root while remaining open", () => {
    window.history.replaceState(null, "", "/one?profile_pane=1&profile_panel=account&profile_detail=phone");
    popProfilePaneLocation("/one", window.location.search);
    expect(resolveProfilePaneUrlState(window.location.search)).toEqual({ open: true, location: ACCOUNT });
    popProfilePaneLocation("/one", window.location.search);
    expect(resolveProfilePaneUrlState(window.location.search)).toEqual({ open: true, location: { panel: null, detail: null } });
  });

  it("closes direct query entry in place while retaining unrelated query parameters", () => {
    window.history.replaceState(
      null,
      "",
      "/one?view=people&profile_pane=1&profile_panel=account",
    );

    closeProfilePane("/one", window.location.search);

    expect(currentUrl().pathname).toBe("/one");
    expect(currentUrl().searchParams.get("view")).toBe("people");
    expect(currentUrl().searchParams.has(PROFILE_PANE_QUERY)).toBe(false);
    expect(currentUrl().searchParams.has(PROFILE_PANE_PANEL_QUERY)).toBe(false);
  });

  it("clears pane query and its internal history marker on authentication loss", () => {
    window.history.replaceState(
      { __hushhProfilePane: { depth: 2 } },
      "",
      "/one?view=people&profile_pane=1&profile_panel=account",
    );

    clearProfilePaneQuery("/one", window.location.search);

    expect(currentUrl().searchParams.get("view")).toBe("people");
    expect(currentUrl().searchParams.has(PROFILE_PANE_QUERY)).toBe(false);
    expect(window.history.state).not.toHaveProperty("__hushhProfilePane");
  });

  it("returns the shell's synchronous answer to an open request, or null with no shell", () => {
    // Voice settles on this answer; a silent drop must not read as an open.
    expect(requestProfilePaneOpen("tap")).toBeNull();

    const listener = (event: Event) =>
      (event as CustomEvent<ProfilePaneOpenDetail>).detail.onResult?.(
        "unavailable",
      );
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, listener);
    try {
      expect(requestProfilePaneOpen("tap")).toBe("unavailable");
    } finally {
      window.removeEventListener(PROFILE_PANE_OPEN_EVENT, listener);
    }
  });
});
