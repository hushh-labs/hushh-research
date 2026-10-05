import { describe, expect, it } from "vitest";

import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { ROUTES } from "@/lib/navigation/routes";

describe("Connector OAuth return route contract", () => {
  it("renders without the app shell, so the sign-in popup shows only its own status", () => {
    // The in-session sign-in finishes in a small popup. If the shell wrapped it,
    // the popup would show the navigation bar and the "Talk to One" bar instead
    // of a bare "finishing" screen that closes itself.
    expect(resolveAppRouteLayout(ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN)).toMatchObject({
      mode: "redirect",
      persistentChrome: "none",
    });
  });
});
