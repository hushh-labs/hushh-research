import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";
import { walkBackNavigationGraph } from "@/lib/navigation/back-navigation-graph";
import {
  buildProfileRoute,
  normalizeProfileDetail,
  profileHostingSetupHref,
  resolveProfileRouteState,
} from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";

describe("onboarding and hosting setup navigational lock", () => {
  it.each([
    ["/onboarding", ROUTES.ONE_SETUP],
    ["/one/onboarding", ROUTES.ONE_SETUP],
    ["/setup", ROUTES.ONE_SETUP],
    ["/one/setup/hosting", ROUTES.ONE_SETUP_CLOUD],
    ["/one/profile/hosting/setup", ROUTES.ONE_SETUP_CLOUD],
    ["/profile/hosting/setup", ROUTES.ONE_SETUP_CLOUD],
  ])("canonicalizes legacy setup alias %s -> %s in middleware", (legacyPath, expectedPath) => {
    const req = new NextRequest(`https://dev.one.hussh.ai${legacyPath}?return_to=%2Fone`);
    const res = proxy(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const redirected = new URL(location!);
    expect(redirected.pathname).toBe(expectedPath);
    expect(redirected.searchParams.get("return_to")).toBe("/one");
  });

  it("preserves Profile Pane hosting origin across Cloud setup Back navigation", () => {
    const paneOrigin = "/?profile_pane=1&profile_panel=hosting";
    const setupHref = profileHostingSetupHref(paneOrigin);
    const parsed = new URL(setupHref, "https://dev.one.hussh.ai");
    expect(parsed.pathname).toBe(ROUTES.ONE_SETUP_CLOUD);
    expect(parsed.searchParams.get("return_to")).toBe(paneOrigin);
    expect(parsed.searchParams.get("from")).toBe(paneOrigin);

    const back = walkBackNavigationGraph(parsed.pathname, parsed.searchParams, {
      persona: "investor",
      signedIn: true,
    });
    expect(back).not.toBeNull();
    expect(back!.backHref).toBe(paneOrigin);
    expect(back!.items.some((item) => item.label === "Hosting" && item.href === paneOrigin)).toBe(
      true,
    );
  });

  it("round-trips focused hosting-details and update-details Profile routes", () => {
    expect(normalizeProfileDetail("hosting", "hosting-details")).toBe("hosting-details");
    expect(normalizeProfileDetail("software-updates", "update-details")).toBe("update-details");
    expect(normalizeProfileDetail("hosting", "update-details")).toBeNull();

    const hostingDetails = buildProfileRoute({ panel: "hosting", detail: "hosting-details" });
    expect(hostingDetails).toBe(`${ROUTES.PROFILE_HOSTING}?detail=hosting-details`);
    expect(resolveProfileRouteState(hostingDetails)).toEqual({
      panel: "hosting",
      detail: "hosting-details",
    });

    const updateDetails = buildProfileRoute({
      panel: "software-updates",
      detail: "update-details",
    });
    expect(updateDetails).toBe(`${ROUTES.PROFILE_SOFTWARE_UPDATES}?detail=update-details`);
    expect(resolveProfileRouteState(updateDetails)).toEqual({
      panel: "software-updates",
      detail: "update-details",
    });
  });
});
