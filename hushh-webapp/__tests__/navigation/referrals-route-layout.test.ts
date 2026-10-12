import { describe, expect, it } from "vitest";

import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";
import { resolveTopShellBreadcrumb, resolveTopShellTitleSlot } from "@/lib/navigation/top-shell-breadcrumbs";
import { resolveTopShellBackAction } from "@/lib/navigation/top-shell-back";
import { resolveTopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("Referrals dashboard route contract", () => {
  it("retains shared profile and bottom chrome with referral sections in the page", () => {
    expect(resolveAppRouteLayout(ROUTES.ONE_REFERRALS)).toMatchObject({
      mode: "standard",
      persistentChrome: "standard",
      interactionLayerPolicy: { allowedFamilies: [] },
    });
    expect(resolveTopShellTabSet(ROUTES.ONE_REFERRALS)).toBeNull();
    expect(resolveTopShellRouteProfile(ROUTES.ONE_REFERRALS)).toMatchObject({
      model: { mode: "bar" },
      metrics: { shellVisible: true, hasTabs: false },
    });
    // The shared shell owns Back; the page owns its single visible heading.
    const breadcrumb = resolveTopShellBreadcrumb(ROUTES.ONE_REFERRALS);
    expect(resolveTopShellTitleSlot(breadcrumb, "Referrals")).toEqual({ kind: "none" });
    expect(resolveTopShellBackAction({ pathname: ROUTES.ONE_REFERRALS })).toMatchObject({ href: ROUTES.ONE_HOME });
  });
});
