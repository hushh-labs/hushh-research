import { describe, expect, it } from "vitest";

import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES, isRiaActionBarRoute } from "@/lib/navigation/routes";

describe("RIA action bar route contract", () => {
  it("shows the shared command surface on RIA workspace routes", () => {
    for (const pathname of [
      ROUTES.RIA_HOME,
      ROUTES.RIA_CLIENTS,
      `${ROUTES.RIA_CLIENTS}/client_123`,
      ROUTES.RIA_PICKS,
      ROUTES.RIA_WORKSPACE,
      ROUTES.RIA_SETTINGS,
    ]) {
      expect(isRiaActionBarRoute(pathname)).toBe(true);
      expect(getKaiChromeState(pathname).hideCommandBar).toBe(false);
    }
  });

  it("keeps RIA onboarding as a fullscreen flow without the action bar", () => {
    for (const pathname of [ROUTES.RIA_ONBOARDING, `${ROUTES.RIA_ONBOARDING}/step-2`]) {
      expect(isRiaActionBarRoute(pathname)).toBe(false);
      expect(getKaiChromeState(pathname).hideCommandBar).toBe(true);
    }
  });
});
