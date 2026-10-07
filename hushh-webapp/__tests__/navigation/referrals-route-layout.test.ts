import { describe, expect, it } from "vitest";

import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { resolveTopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("Referrals dashboard route contract", () => {
  it("owns an immersive route without persistent app chrome or TopShell tabs", () => {
    // Same recipe as /one/location/map (see location-map-route-layout.test.ts):
    // the dashboard renders its own sticky header, tab bar and floating invite
    // dock, so the global TopShell bar and the bottom "Talk to One" / nav
    // shell must stay out of the way rather than double up with it.
    expect(resolveAppRouteLayout(ROUTES.ONE_REFERRALS)).toMatchObject({
      mode: "hidden",
      persistentChrome: "none",
      interactionLayerPolicy: { allowedFamilies: [] },
    });
    expect(resolveTopShellTabSet(ROUTES.ONE_REFERRALS)).toBeNull();
  });
});
