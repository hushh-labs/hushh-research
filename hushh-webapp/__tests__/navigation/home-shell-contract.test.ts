import { describe, expect, it } from "vitest";

import { resolveTopShellMetrics } from "@/components/app-ui/top-shell-metrics";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { ROUTES } from "@/lib/navigation/routes";

describe("home shell contract", () => {
  it("treats the signed-in One dashboard as a standard shell route", () => {
    expect(resolveAppRouteLayout(ROUTES.ONE_HOME).mode).toBe("standard");
    expect(resolveTopShellMetrics(ROUTES.ONE_HOME).shellVisible).toBe(true);
    expect(getKaiChromeState(ROUTES.ONE_HOME).hideCommandBar).toBe(false);
  });

  it("keeps Connect inside the standard signed-in shell", () => {
    expect(resolveAppRouteLayout(ROUTES.CONNECT).mode).toBe("standard");
    expect(resolveTopShellMetrics(ROUTES.CONNECT).shellVisible).toBe(true);
    expect(getKaiChromeState(ROUTES.CONNECT).hideCommandBar).toBe(false);
  });

  it("keeps contextual Finance and Location tabs inside the shared top shell", () => {
    expect(resolveTopShellMetrics(ROUTES.ONE_LOCATION).hasTabs).toBe(true);
    expect(resolveTopShellMetrics(ROUTES.KAI_HOME).hasTabs).toBe(true);
    expect(resolveTopShellMetrics(ROUTES.KAI_ANALYSIS).hasTabs).toBe(true);
    expect(resolveTopShellMetrics("/one/location?action=share").hasTabs).toBe(
      false,
    );
    expect(resolveTopShellMetrics(ROUTES.RIA_PICKS).hasTabs).toBe(true);
    expect(resolveTopShellMetrics(ROUTES.PROFILE).hasTabs).toBe(false);
    expect(resolveTopShellMetrics(ROUTES.CONNECT).hasTabs).toBe(false);
  });

  it("keeps the persistent chrome on every Location task flow", () => {
    // SOS and SMS contacts used to hide the top and bottom chrome, which took
    // the back control, the "Location › …" trail and the profile avatar off
    // exactly two screens and forced each to draw a private back button.
    // Chrome visibility is a property of the ROUTE, so `?action=` never
    // changes it — a route that needs a bare canvas says so in the layout
    // contract instead.
    for (const action of ["sos", "sms-contacts", "share", "settings", null]) {
      const query = action ? `?action=${action}` : "";
      expect(
        resolveTopShellMetrics(`${ROUTES.ONE_LOCATION}${query}`).shellVisible,
      ).toBe(true);
    }
    expect(resolveAppRouteLayout(ROUTES.ONE_LOCATION).persistentChrome).not.toBe(
      "none",
    );
  });

  it("keeps auth-only routes out of the shared command surface", () => {
    expect(getKaiChromeState(ROUTES.LOGIN).hideCommandBar).toBe(true);
    expect(resolveTopShellMetrics(ROUTES.LOGIN).shellVisible).toBe(false);
  });
});
