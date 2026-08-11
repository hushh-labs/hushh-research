import { describe, expect, it } from "vitest";

import {
  buildCheckInHrefFromYourMap,
  resolveCheckInDismissHref,
} from "@/lib/one-location/check-in-navigation";

/**
 * Nearby check-in has two openers -- Your Map and the Location hub -- and one
 * dismiss control.
 *
 * When check-in moved from a drawer over Your Map to its own route, dismiss was
 * pointed at the Location hub for everyone. That is right for the hub's own
 * "Check in" card and wrong for Your Map: checking in from the map and closing
 * the sheet threw the person two screens back, past the map they were standing
 * on, at the moment they had just made themselves discoverable. These cases
 * exist so a third opener cannot repeat that quietly.
 */
describe("resolveCheckInDismissHref", () => {
  it("returns to Your Map when Your Map opened it", () => {
    expect(resolveCheckInDismissHref("map")).toBe("/one/location/map");
  });

  it("falls back to the Location hub when no opener is recorded", () => {
    // The hub's own check-in card records nothing, and neither does a deep
    // link or a refreshed legacy URL. The hub is where those belong.
    expect(resolveCheckInDismissHref(null)).toBe("/one/location");
    expect(resolveCheckInDismissHref(undefined)).toBe("/one/location");
    expect(resolveCheckInDismissHref("")).toBe("/one/location");
  });

  it("does not treat a near-miss source as Your Map", () => {
    // Compared exactly, so a stale or hand-edited param cannot pick the
    // destination.
    expect(resolveCheckInDismissHref("Map")).toBe("/one/location");
    expect(resolveCheckInDismissHref(" map")).toBe("/one/location");
    expect(resolveCheckInDismissHref("map-view")).toBe("/one/location");
    expect(resolveCheckInDismissHref("nearby")).toBe("/one/location");
  });
});

describe("buildCheckInHrefFromYourMap", () => {
  it("names the check-in route and records Your Map as the opener", () => {
    expect(buildCheckInHrefFromYourMap(new URLSearchParams())).toBe(
      "/one/location/check-in?source=map",
    );
  });

  it("keeps the map's own query so entering check-in does not reset it", () => {
    const href = buildCheckInHrefFromYourMap(
      new URLSearchParams("demo=people"),
    );

    expect(href).toBe("/one/location/check-in?demo=people&source=map");
  });

  it("drops a legacy action param instead of carrying it onto the route", () => {
    // `?action=check-in` is the old drawer entry. Riding along would leave the
    // new route wearing the query that the redirect exists to retire.
    const href = buildCheckInHrefFromYourMap(
      new URLSearchParams("action=check-in"),
    );

    expect(href).toBe("/one/location/check-in?source=map");
  });

  it("overwrites a stale source rather than inheriting it", () => {
    const href = buildCheckInHrefFromYourMap(new URLSearchParams("source=sos"));

    expect(href).toBe("/one/location/check-in?source=map");
  });
});
