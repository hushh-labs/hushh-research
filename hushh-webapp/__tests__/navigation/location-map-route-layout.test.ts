import { describe, expect, it } from "vitest";

import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { resolveTopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("Location Your Map route contract", () => {
  it("owns an immersive route without persistent app chrome or Location tabs", () => {
    expect(resolveAppRouteLayout(ROUTES.ONE_LOCATION_MAP)).toMatchObject({
      mode: "hidden",
      persistentChrome: "none",
      interactionLayerPolicy: { allowedFamilies: [] },
    });
    expect(resolveTopShellTabSet(ROUTES.ONE_LOCATION_MAP)).toBeNull();
  });
});
