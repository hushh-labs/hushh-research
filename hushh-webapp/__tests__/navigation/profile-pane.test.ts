// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_PANE_DETAIL_QUERY,
  PROFILE_PANE_PANEL_QUERY,
  PROFILE_PANE_QUERY,
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
  resolveProfilePaneUrlState,
} from "@/lib/navigation/profile-pane";

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
