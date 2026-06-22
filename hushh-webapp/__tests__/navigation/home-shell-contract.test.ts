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

  it("keeps auth-only routes out of the shared command surface", () => {
    expect(getKaiChromeState(ROUTES.LOGIN).hideCommandBar).toBe(true);
    expect(resolveTopShellMetrics(ROUTES.LOGIN).shellVisible).toBe(false);
  });
});
