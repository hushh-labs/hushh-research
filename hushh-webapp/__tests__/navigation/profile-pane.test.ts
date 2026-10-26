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
  profileLegalParentForPresentation,
  profilePanelParentForPresentation,
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
import { backProfilePane } from "@/lib/navigation/profile-pane-back";
import { projectNativeProfileLegal } from "@/components/profile/profile-native-legal";

import { registerBackLayer } from "@/lib/navigation/back-layers";

const ACCOUNT = { panel: "account" as const, detail: null };
const PHONE = { panel: "account" as const, detail: "phone" as const };

function currentUrl() {
  return new URL(window.location.href);
}

describe("Profile pane navigation state", () => {
  it("projects only visited panel parents owned by Back, preserving replacements and ambiguous-entry fallback", () => {
    window.history.replaceState(null, "", "/one");
    openProfilePane("/one", window.location.search);
    pushProfilePaneLocation("/one", window.location.search, profileLegalLocation("privacy"));
    expect(profileLegalParentForPresentation()).toBe(false);
    replaceProfilePaneLocation("/one", window.location.search, profileLegalLocation("terms"));
    expect(profileLegalParentForPresentation()).toBe(false);
    expect(projectNativeProfileLegal("terms", vi.fn(), vi.fn(), profileLegalParentForPresentation() === true).pages.map(page => page.id)).toEqual(["terms"]);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    try { popProfilePaneLocation("/one", window.location.search); expect(back).toHaveBeenCalledOnce(); }
    finally { back.mockRestore(); }

    window.history.replaceState(null, "", "/one");
    openProfilePane("/one", window.location.search);
    pushProfilePaneLocation("/one", window.location.search, { panel: "legal", detail: null });
    pushProfilePaneLocation("/one", window.location.search, profileLegalLocation("privacy"));
    replaceProfilePaneLocation("/one", window.location.search, profileLegalLocation("terms"));
    expect(profileLegalParentForPresentation()).toBe(true);
    const legal = projectNativeProfileLegal("terms", vi.fn(), vi.fn(), true);
    expect(legal.pages.map(page => page.id)).toEqual(["legal", "terms"]);
    expect(legal.pages[0].sections[0].rows.map(({ id, artworkId }) => ({ id, artworkId }))).toEqual([
      { id: "legal-open-privacy", artworkId: "privacy" }, { id: "legal-open-terms", artworkId: "terms" },
    ]);
    // A native return-to-root can replace a deeper entry in place. Depth
    // alone must not invent a Legal parent on the next direct document visit.
    replaceProfilePaneLocation("/one", window.location.search, { panel: null, detail: null });
    pushProfilePaneLocation("/one", window.location.search, profileLegalLocation("privacy"));
    expect(profileLegalParentForPresentation()).toBe(false);

    window.history.replaceState(null, "", "/one?profile_pane=1&profile_panel=legal&profile_detail=privacy");
    expect(profileLegalParentForPresentation()).toBe(true);
    popProfilePaneLocation("/one", window.location.search);
    expect(resolveProfilePaneUrlState(window.location.search).location).toEqual({ panel: "legal", detail: null });
    window.history.replaceState({ __hushhProfilePane: { depth: 2 } }, "", window.location.href);
    expect(profileLegalParentForPresentation()).toBeNull();
    window.history.replaceState(null, "", "/one");
    openProfilePane("/one", window.location.search, profileLegalLocation("privacy"), { returnsToOrigin: true });
    replaceProfilePaneLocation("/one", window.location.search, profileLegalLocation("terms"));
    expect(profileLegalParentForPresentation()).toBe(false);

    window.history.replaceState(null, "", "/one");
    openProfilePane("/one", window.location.search);
    pushProfilePaneLocation("/one", window.location.search, { panel: "preferences", detail: "voice" });
    expect(profilePanelParentForPresentation("preferences")).toBe(false);
    replaceProfilePaneLocation("/one", window.location.search, { panel: null, detail: null });
    pushProfilePaneLocation("/one", window.location.search, { panel: "preferences", detail: null });
    pushProfilePaneLocation("/one", window.location.search, { panel: "preferences", detail: "voice" });
    expect(profilePanelParentForPresentation("preferences")).toBe(true);
    window.history.replaceState({ __hushhProfilePane: { depth: 3 } }, "", window.location.href);
    expect(profilePanelParentForPresentation("preferences")).toBeNull();
    window.history.replaceState({ __hushhProfilePane: { depth: 3, parentPanel: "security" } }, "", window.location.href);
    expect(profilePanelParentForPresentation("preferences")).toBeNull();
    window.history.replaceState({ __hushhProfilePane: { depth: 2, legalParent: false } }, "", window.location.href);
    expect(profileLegalParentForPresentation()).toBe(false);
  });
  it("unwinds the pane's local step before its query parent without touching the covered workspace", () => {
    window.history.replaceState(null, "", "/one?profile_pane=1&profile_panel=account&profile_detail=phone");
    const workspaceBack = vi.fn(() => true);
    const phoneBack = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const removeWorkspace = registerBackLayer({ pathname: "/one", depth: 100, back: workspaceBack });
    const removePhone = registerBackLayer({ pathname: "/one", depth: 2, query: { profile_pane: "1" }, back: phoneBack });
    try {
      // A local step consumed Back without changing the pane's route. A
      // native pop must be refused, not acknowledged while awaiting a route
      // projection that will never arrive.
      expect(backProfilePane("/one", new URLSearchParams(window.location.search))).toBe(false);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(PHONE);
      expect(phoneBack).toHaveBeenCalledOnce();
      expect(workspaceBack).not.toHaveBeenCalled();
      expect(backProfilePane("/one", new URLSearchParams(window.location.search))).toBe(true);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(ACCOUNT);
      expect(phoneBack).toHaveBeenCalledTimes(2);
      expect(workspaceBack).not.toHaveBeenCalled();
    } finally { removePhone(); removeWorkspace(); }
  });
  it.each(["payouts", "world-model", "request-pricing"] as const)("opens %s in the existing pane and returns to Profile", (panel) => {
    const state = resolveProfilePaneUrlState(`profile_pane=1&profile_panel=${panel}`);
    expect(state).toEqual({ open: true, location: { panel, detail: null } });
    expect(profilePaneParentLocation(state.location)).toEqual({ panel: null, detail: null });
    expect(buildProfilePaneHref("/one/feed", null, state.location)).toBe(`/one/feed?profile_pane=1&profile_panel=${panel}`);
  });

  it("keeps the model and what a link carries in the pane", () => {
    // proxy.ts sends /one/profile/world-model links here with their query.
    const pane = "profile_pane=1&profile_panel=world-model&handoff=h1&draft_id=d1";
    expect(resolveProfilePaneUrlState(pane)).toEqual({
      open: true,
      location: { panel: "world-model", detail: null },
    });
    expect(buildProfilePaneHref("/one", pane, { panel: "world-model", detail: null })).toBe(
      "/one?profile_pane=1&profile_panel=world-model&handoff=h1&draft_id=d1",
    );
    expect(resolveProfileRouteState("/one/profile/world-model?claim=synthetic-token")).toEqual({
      panel: "world-model", detail: null,
    });
    expect(buildProfileRoute({ panel: "world-model", searchParams: "from=%2Fone%2Ffeed" })).toBe(
      "/one/profile/world-model?from=%2Fone%2Ffeed",
    );
  });

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

  it.each(["instagram", "linkedin"])("returns from %s link entry to Connectors on Back", (id) => {
    const state = resolveProfilePaneUrlState(
      `profile_pane=1&profile_panel=connectors&profile_detail=connector:${id}`,
    );
    expect(state.location).toEqual({ panel: "connectors", detail: `connector:${id}` });
    expect(profilePaneParentLocation(state.location)).toEqual({ panel: "connectors", detail: null });
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

  it("unwinds only active pane disclosures before navigation, preserving Phone and underlying Memory", () => {
    openProfilePane("/one", window.location.search, ACCOUNT);
    const underlying = vi.fn(() => true);
    const releaseUnderlying = registerBackLayer({ pathname: "/one", depth: 9, back: underlying });
    let receipt = true, history = true;
    const query = { profile_pane: "1", profile_panel: "account" };
    const releaseHistory = registerBackLayer({ pathname: "/one", query, depth: 1, back: () => {
      if (!history) return false;
      history = false; return true;
    } });
    const releaseReceipt = registerBackLayer({ pathname: "/one", query, depth: 2, back: () => {
      if (!receipt) return false;
      receipt = false; return true;
    } });
    try {
      popProfilePaneLocation("/one", window.location.search);
      expect(receipt).toBe(false); expect(history).toBe(true);
      popProfilePaneLocation("/one", window.location.search);
      expect(history).toBe(false);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(ACCOUNT);
      popProfilePaneLocation("/one", window.location.search);
      expect(resolveProfilePaneUrlState(window.location.search).location.panel).toBeNull();
      replaceProfilePaneLocation("/one", window.location.search, PHONE);
      history = true;
      popProfilePaneLocation("/one", window.location.search);
      expect(history).toBe(true);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(ACCOUNT);
      expect(underlying).not.toHaveBeenCalled();
    } finally { releaseReceipt(); releaseHistory(); releaseUnderlying(); }
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

  it("keeps a returned untracked Profile root in-place through nested Back and Close", () => {
    // Referrals' authored Back restores its initiating Profile URL through
    // Next navigation, not the original pane's browser-history metadata.
    window.history.replaceState(null, "", "/?view=recent&profile_pane=1");
    const initialLength = window.history.length;
    const go = vi.spyOn(window.history, "go");
    try {
      pushProfilePaneLocation("/", window.location.search, ACCOUNT);
      pushProfilePaneLocation("/", window.location.search, PHONE);
      expect(window.history.length).toBe(initialLength);
      expect(getProfilePaneHistoryDepth()).toBe(0);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(PHONE);
      popProfilePaneLocation("/", window.location.search);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual(ACCOUNT);
      popProfilePaneLocation("/", window.location.search);
      expect(resolveProfilePaneUrlState(window.location.search).location).toEqual({ panel: null, detail: null });
      closeProfilePane("/", window.location.search);
      expect(currentUrl().searchParams.get("view")).toBe("recent");
      expect(resolveProfilePaneUrlState(window.location.search).open).toBe(false);
      expect(go).not.toHaveBeenCalled();
      window.history.replaceState(null, "", "/?view=recent&profile_pane=1");
      pushProfilePaneLocation("/", window.location.search, PHONE);
      closeProfilePane("/", window.location.search);
      expect(resolveProfilePaneUrlState(window.location.search).open).toBe(false);
      expect(currentUrl().searchParams.get("view")).toBe("recent");
      expect(go).not.toHaveBeenCalled();
    } finally { go.mockRestore(); }
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

  it("hands an authored detail and return target to the shell without a second navigation or policy bypass", () => {
    const trigger = document.createElement("button");
    const before = window.location.href;
    for (const outcome of ["opening", "unavailable"] as const) {
      const listener = vi.fn((event: Event) => {
        const detail = (event as CustomEvent<ProfilePaneOpenDetail>).detail;
        expect(detail.returnFocus).toBe(trigger);
        expect(detail.destination).toEqual({ location: PHONE, returnsToOrigin: true });
        detail.onResult?.(outcome);
      });
      window.addEventListener(PROFILE_PANE_OPEN_EVENT, listener);
      try {
        openProfilePane("/one", window.location.search, PHONE, { returnsToOrigin: true, returnFocus: trigger });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(window.location.href).toBe(before);
      } finally { window.removeEventListener(PROFILE_PANE_OPEN_EVENT, listener); }
    }
  });
});
