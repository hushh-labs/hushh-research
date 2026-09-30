// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_PANE_DETAIL_QUERY,
  PROFILE_PANE_PANEL_QUERY,
  PROFILE_PANE_QUERY,
  buildProfileConnectorsPaneHref,
  buildProfilePaneCloseHref,
  buildProfilePaneHref,
  canGoBackProfilePane,
  clearProfilePaneQuery,
  closeProfilePane,
  getProfilePaneHistoryDepth,
  popProfilePaneLocation,
  profilePaneParentLocation,
  openProfilePane,
  pushProfilePaneLocation,
  replaceProfilePaneLocation,
  resolveProfilePaneUrlState,
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

    // The legacy route (rendered by the native bundle) means the same place.
    expect(
      resolveProfileRouteState("/one/profile/connectors?connector=gmail"),
    ).toEqual({ panel: "connectors", detail: "connector:gmail" });
    expect(
      buildProfileRoute({ panel: "connectors", detail: "connector:gmail" }),
    ).toBe("/one/profile/connectors?connector=gmail");
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
});
