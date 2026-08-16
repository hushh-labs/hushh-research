/**
 * A back target must never be a bare pathname when the screen it leaves has a
 * query string.
 *
 * The App Router will not perform a navigation whose only change is that the
 * whole query string disappears. Measured on uat.one.hushh.ai and on
 * one.hushh.ai, signed in, on an iPhone-sized viewport:
 *
 *   /one/location?action=settings -> /one/location        no navigation
 *   /one/location?view=people     -> /one/location        no navigation
 *   /one/location?action=settings -> /one/location?view=people   works
 *   /one/location?action=settings -> /one/feed                   works
 *   /one/feed?tab=x -> /one/feed, /one?x=1 -> /one,
 *   /one/connect?x=1 -> /one/connect                      no navigation
 *
 * Every Location flow closes by removing `?action=` and nothing else, which is
 * exactly the refused shape — so every flow became impossible to leave by its
 * own back control, while the phone's own back gesture, which never goes
 * through the router, still worked.
 */
import { describe, expect, it } from "vitest";

import { resolveTopShellBackAction } from "@/lib/navigation/top-shell-back";
import { ROUTES } from "@/lib/navigation/routes";

const LOCATION_ACTIONS = [
  "settings",
  "needs-review",
  "active-shares",
  "shared-with-me",
  "share",
  "ask",
  "invite",
  "temp-link",
  "sos",
];

describe("a Location flow's back target survives the router", () => {
  it.each(LOCATION_ACTIONS)(
    "leaves ?action=%s for a hub URL that still carries a query",
    (action) => {
      const back = resolveTopShellBackAction({
        pathname: ROUTES.ONE_LOCATION,
        searchParams: new URLSearchParams(`action=${action}`),
      });

      expect(back).not.toBeNull();
      expect(back?.href).toContain("?");
      expect(back?.href).not.toBe(ROUTES.ONE_LOCATION);
      expect(back?.href.split("?")[0]).toBe(ROUTES.ONE_LOCATION);
    },
  );

  it("returns to the tab the flow was opened from, not the default", () => {
    expect(
      resolveTopShellBackAction({
        pathname: ROUTES.ONE_LOCATION,
        searchParams: new URLSearchParams("action=temp-link&view=links"),
      })?.href,
    ).toBe(`${ROUTES.ONE_LOCATION}?view=links`);
  });

  it("names the default tab explicitly when the flow carries no tab", () => {
    expect(
      resolveTopShellBackAction({
        pathname: ROUTES.ONE_LOCATION,
        searchParams: new URLSearchParams("action=settings"),
      })?.href,
    ).toBe(`${ROUTES.ONE_LOCATION}?view=now`);
  });

  it("keeps SMS contacts retracing to the flow that opened it", () => {
    expect(
      resolveTopShellBackAction({
        pathname: ROUTES.ONE_LOCATION,
        searchParams: new URLSearchParams("action=sms-contacts"),
      })?.href,
    ).toBe(`${ROUTES.ONE_LOCATION}?action=settings`);
  });

  it("still closes a flow in place rather than retracing the trail", () => {
    expect(
      resolveTopShellBackAction({
        pathname: ROUTES.ONE_LOCATION,
        searchParams: new URLSearchParams("action=settings"),
      }),
    ).toMatchObject({ mode: "replace", transitionMode: "contextual" });
  });

  it("leaves a real screen change alone — Your Map still crossfades", () => {
    expect(
      resolveTopShellBackAction({ pathname: ROUTES.ONE_LOCATION_MAP }),
    ).toMatchObject({ href: ROUTES.ONE_LOCATION, transitionMode: "full" });
  });
});

describe("the hub never writes a bare URL either", () => {
  it("always names the tab when switching tabs or closing a flow", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "components/one-location/redesign/location-redesign-hub.tsx",
      ),
      "utf8",
    );

    // Every path that drops `?action=` must name a tab in its place,
    // otherwise it can leave the query empty and the navigation never happens.
    // Deleting the tab param is only safe where an action is set alongside it.
    expect(source).toContain("params.set(LOCATION_HUB_TAB_PARAM, next)");
    expect(source).toContain(
      "params.set(LOCATION_HUB_TAB_PARAM, nextTab ?? tab)",
    );
    expect(source).toContain('params.set(LOCATION_HUB_TAB_PARAM, nextTab ?? "now")');
    expect(source).toContain('params.set(LOCATION_HUB_TAB_PARAM, "now")');

    const deletesTab = source.split("params.delete(LOCATION_HUB_TAB_PARAM)");
    // The one permitted deletion sets an action on the very next lines, so the
    // query cannot come out empty.
    expect(deletesTab).toHaveLength(2);
    expect(deletesTab[1].slice(0, 120)).toContain(
      "params.set(FLOW_ACTION_PARAM",
    );
  });
});
