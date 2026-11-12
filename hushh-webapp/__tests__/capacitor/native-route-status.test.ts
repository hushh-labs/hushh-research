import { describe, expect, it } from "vitest";

import { nativeRouteReportMatches } from "../../scripts/native/native-route-status.mjs";

describe("native route audit report matching", () => {
  it("uses the native exact-route verdict when private query values are redacted", () => {
    const route = {
      expectedRoute: "/circle/join?code=native-invitation-fixture",
    };

    expect(
      nativeRouteReportMatches(
        { route: "/circle/join", routeok: "1" },
        route,
      ),
    ).toBe(true);
    expect(
      nativeRouteReportMatches(
        { route: "/circle/join", routeok: "0" },
        route,
      ),
    ).toBe(false);
    expect(
      nativeRouteReportMatches(
        { route: "/login", routeok: "1" },
        route,
      ),
    ).toBe(false);
  });

  it("checks prefixes against the sanitized route path", () => {
    expect(
      nativeRouteReportMatches(
        { route: "/one/kai/analysis", routeok: "1" },
        { expectedRoutePrefix: "/one/kai" },
      ),
    ).toBe(true);
    expect(
      nativeRouteReportMatches(
        { route: "/login", routeok: "1" },
        { expectedRoutePrefix: "/one/kai" },
      ),
    ).toBe(false);
    expect(
      nativeRouteReportMatches(
        { route: "/one/kaizen", routeok: "1" },
        { expectedRoutePrefix: "/one/kai" },
      ),
    ).toBe(false);
  });
});
