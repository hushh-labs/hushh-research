import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";
import { buildCheckInHrefFromYourMap } from "@/lib/one-location/check-in-navigation";
import { buildNearbyCheckInResumeHref } from "@/lib/one-location/nearby-private-navigation";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function json(relativePath: string): unknown {
  return JSON.parse(source(relativePath));
}

/**
 * The file with its comments removed.
 *
 * Every one of these modules explains in prose why it no longer builds the old
 * href, and the explanation has to name it. Matching raw source would fail on
 * the comment that exists to stop the bug coming back.
 */
function code(relativePath: string): string {
  return source(relativePath)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/**
 * Nearby check-in has one destination, and Your Map is not it.
 *
 * The two screens share a renderer but not a product: Your Map answers "where
 * are the people who already share with me", and withholds the check-in sheet,
 * the place list and the attendee list unless the surface is check-in. Every
 * way into the flow nonetheless named `/one/location/map?action=check-in` and
 * relied on the map's own redirect to carry on to `/one/location/check-in`.
 *
 * What that cost was visible: the wrong map mounted and painted, the Google
 * renderer was built and torn down for nothing, a history entry nobody asked
 * for was left behind, and someone asking One to check in watched two screens
 * they had not asked for go past. Asking by voice was the worst of them --
 * hub, then Your Map, then check-in.
 *
 * The legacy `?action=check-in` redirect stays, because links we do not own
 * (notifications, anything already shared, bookmarks) still carry it. Nothing
 * inside the app may use it.
 */
describe("nearby check-in destination", () => {
  const MAP_CHECK_IN_HREF = /one\/location\/map\?action=check-in/;

  it("has no in-app caller that routes check-in through Your Map", () => {
    const callers = [
      "components/one-location/redesign/location-redesign-hub.tsx",
      "components/one-location/location-immersive-map.tsx",
      "lib/one-location/nearby-private-navigation.ts",
      "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
      "lib/one-location/check-in-navigation.ts",
      "lib/navigation/top-shell-breadcrumbs.ts",
    ];
    for (const caller of callers) {
      const text = code(caller);
      expect(text).not.toMatch(MAP_CHECK_IN_HREF);
      // The same href assembled from the route constant, which is how every
      // one of these was actually written.
      expect(text).not.toMatch(/ONE_LOCATION_MAP\}\?action=check-in/);
    }
  });

  it("gives Nearby Check-In its own route, separate from the Check-In tile", () => {
    const hub = source("components/one-location/redesign/location-redesign-hub.tsx");
    // The hub's "Nearby" row -- not the Check-In tile -- owns the only
    // in-hub navigation to Nearby Check-In's dedicated route.
    expect(hub).toContain("router.push(ROUTES.ONE_LOCATION_CHECK_IN)");
  });

  it("never redirects the Check-In tile or its deep link into Nearby (#5459)", () => {
    // Nearby Check-In being available used to make `?action=check-in` --
    // the tile's own navigation and One's own execution of
    // location.open_check_in -- hand off to Nearby's map surface instead of
    // the private "send a note" flow the tile promises ("Share now") and the
    // contract action describes ("send a one-off note of where you are").
    // Nearby now has its own entry (the "Nearby" row); this action must
    // never again be redirected into it just because it happens to be on.
    const hub = code("components/one-location/redesign/location-redesign-hub.tsx");
    expect(hub).not.toContain("router.replace(ROUTES.ONE_LOCATION_CHECK_IN");
  });

  it("resumes a private check-in on check-in's own route", () => {
    const token = "123e4567-e89b-12d3-a456-426614174000";
    expect(buildNearbyCheckInResumeHref(token)).toBe(
      `${ROUTES.ONE_LOCATION_CHECK_IN}?resume=${token}`,
    );
  });

  it("returns the private check-in back button to check-in, not Your Map", () => {
    const params = new URLSearchParams({
      action: "private-check-in",
      source: "nearby",
    });
    expect(resolveTopShellBreadcrumb(ROUTES.ONE_LOCATION, params)?.backHref).toBe(
      ROUTES.ONE_LOCATION_CHECK_IN,
    );
  });

  it("keeps Your Map's own Check in pill to a single navigation", () => {
    const params = new URLSearchParams({ action: "check-in", demo: "people" });
    // The retired `action` is dropped rather than carried onto the route that
    // exists to retire it; everything else the map was showing survives.
    expect(buildCheckInHrefFromYourMap(params)).toBe(
      `${ROUTES.ONE_LOCATION_CHECK_IN}?demo=people`,
    );
  });

  it("still redirects the legacy entry point for links we do not own", () => {
    const map = source("components/one-location/location-immersive-map.tsx");
    expect(map).toContain('if (!isCheckInSurface && action === "check-in")');
    expect(map).toContain("ROUTES.ONE_LOCATION_CHECK_IN");
  });

  it("sends check-in arrivals to the hub flow when nearby check-in is off", () => {
    // Buttons are all gated on availability; a bookmark or an old notification
    // is not, and landing on a place list the backend will refuse is a dead
    // end with nothing on screen to explain it. Held on the page, before the
    // map renders: a screen that cannot show check-in must not be built at all,
    // not built and then redirected off a frame later.
    const page = source("app/one/location/check-in/page.tsx");
    expect(page).toContain("isOneLocationNearbyCheckInAvailable()");
    expect(page).toContain("`${ROUTES.ONE_LOCATION}?action=check-in`");
    expect(page).toContain("if (!nearbyAvailable) return null;");
  });
});

/**
 * What One believes it can do on Your Map.
 *
 * The route index is the executor's inventory: an action absent from it comes
 * back as `action_unavailable` on the very screen that shows the control. Your
 * Map carries a "Check in" pill, so "check in" spoken there has to be a thing
 * One can do -- previously the map's whole inventory was `location.open_map`,
 * the screen the person was already standing on.
 */
describe("check-in is reachable by voice from Your Map", () => {
  const index = json("contracts/kai/one-route-orchestration-index.v1.json") as {
    routes: {
      route_pattern: string;
      canonical_screen: string | null;
      action_ids: string[];
    }[];
  };
  const gateway = json("contracts/kai/kai-action-gateway.vnext.json") as {
    actions: {
      action_id: string;
      reachability?: { routes?: string[]; screens?: string[] };
      execution_target?: { path?: string; target?: string };
    }[];
  };

  it("lists check-in in the map route's inventory", () => {
    const mapRoute = index.routes.find(
      (route) => route.route_pattern === ROUTES.ONE_LOCATION_MAP,
    );
    expect(mapRoute?.action_ids).toContain("location.open_check_in");
  });

  it("declares the map screen and its pill on the contract action", () => {
    const action = gateway.actions.find(
      (candidate) => candidate.action_id === "location.open_check_in",
    );
    expect(action?.reachability?.screens).toContain("one_location_map");
    expect(action?.reachability?.routes).toContain(ROUTES.ONE_LOCATION_MAP);
  });

  it("names a target One can actually watch arrive", () => {
    const action = gateway.actions.find(
      (candidate) => candidate.action_id === "location.open_check_in",
    );
    // Settlement matches the target exactly when it carries a query
    // (`routeMatchesTarget` in lib/voice/voice-action-settlement.ts), so a
    // target that redirects can never be observed arriving. The old
    // `/one/location?action=check-in` was replaced within the frame, so One
    // waited out its 1800 ms window and reported "the next screen is still
    // settling" on a check-in that had in fact opened. Naming the destination
    // is what makes the wait end.
    expect(action?.execution_target?.target).toBe(ROUTES.ONE_LOCATION_CHECK_IN);
    expect(action?.execution_target?.target).not.toContain("?");
  });
});
