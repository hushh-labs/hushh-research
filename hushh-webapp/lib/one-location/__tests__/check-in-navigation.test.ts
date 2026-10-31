import { describe, expect, it } from "vitest";

import { buildCheckInHrefFromYourMap } from "@/lib/one-location/check-in-navigation";

describe("buildCheckInHrefFromYourMap", () => {
  it("names the check-in route directly", () => {
    expect(buildCheckInHrefFromYourMap(new URLSearchParams())).toBe(
      "/one/location/check-in",
    );
  });

  it("keeps the map's own query so entering check-in does not reset it", () => {
    const href = buildCheckInHrefFromYourMap(
      new URLSearchParams("demo=people"),
    );

    expect(href).toBe("/one/location/check-in?demo=people");
  });

  it("drops a legacy action param instead of carrying it onto the route", () => {
    // `?action=check-in` is the old drawer entry. Riding along would leave the
    // new route wearing the query that the redirect exists to retire.
    const href = buildCheckInHrefFromYourMap(
      new URLSearchParams("action=check-in"),
    );

    expect(href).toBe("/one/location/check-in");
  });

  it("leaves no trailing '?' when dropping the only param", () => {
    expect(
      buildCheckInHrefFromYourMap(new URLSearchParams("action=check-in")),
    ).not.toContain("?");
  });
});
