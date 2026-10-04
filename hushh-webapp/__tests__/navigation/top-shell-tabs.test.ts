import { describe, expect, it } from "vitest";

import {
  buildConsentCenterTabRoute,
  resolvePublicKnowledgeTopShellTabSet,
  resolveRiaRouteTabSet,
  resolveTopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";

describe("top shell contextual tabs", () => {
  it("keeps Location tabs inside the Location hub instead of the global top shell", () => {
    // The Location page renders Now / People / Links under the module header.
    // Keeping them in the fixed top shell puts the tabs before "Location" and
    // reverses the hierarchy, especially visible on the Links tab.
    expect(resolveTopShellTabSet("/one/location")).toBeNull();
    expect(resolveTopShellTabSet("/one/location?view=inbox")).toBeNull();
    expect(resolveTopShellTabSet("/one/location?action=share")).toBeNull();
    expect(resolveTopShellTabSet("/one/location/map")).toBeNull();
  });

  it("keeps Finance tabs below its route-owned header", () => {
    expect(resolveTopShellTabSet("/one/kai")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai?tab=analysis")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/?tab=portfolio")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/holdings")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/allocation")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/performance")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/sources")).toBeNull();
    expect(
      resolveTopShellRouteProfile("/one/kai/?tab=analysis").model,
    ).toMatchObject({
      mode: "bar",
    });
  });

  it("keeps Consent Center tabs below its route-owned header", () => {
    expect(
      resolveTopShellTabSet(
        "/one/consent?tab=history&q=tax&page=3&requestId=req_123&from=%2Fone",
      ),
    ).toBeNull();
    expect(
      buildConsentCenterTabRoute(
        "active",
        new URLSearchParams("tab=history&q=tax&page=3&requestId=req_123&from=%2Fone"),
      ),
    ).toBe(
      "/one/consent?tab=active&from=%2Fone",
    );
    expect(
      resolveTopShellRouteProfile("/one/consent?tab=connections").model,
    ).toMatchObject({
      mode: "bar",
    });
    expect(resolveTopShellTabSet("/one/consent/?tab=active")).toBeNull();
  });

  it("keeps RIA workspace tabs below the page header instead of in the fixed top shell", () => {
    expect(resolveTopShellTabSet("/ria")).toBeNull();
    expect(resolveTopShellTabSet("/ria/profile")).toBeNull();
    expect(resolveTopShellTabSet("/ria/clients")).toBeNull();
    expect(resolveTopShellTabSet("/ria/picks")).toBeNull();
    expect(resolveTopShellRouteProfile("/ria/clients").model).toMatchObject({
      mode: "bar",
    });

    expect(resolveRiaRouteTabSet("/ria")).toMatchObject({
      id: "ria",
      label: "RIA workspace",
      activeValue: "profile",
    });
    expect(resolveRiaRouteTabSet("/ria/profile")).toMatchObject({
      id: "ria",
      activeValue: "profile",
    });
    expect(resolveRiaRouteTabSet("/ria/clients")).toMatchObject({
      id: "ria",
      activeValue: "clients",
    });
    expect(resolveRiaRouteTabSet("/ria/picks")).toMatchObject({
      id: "ria",
      activeValue: "picks",
    });
  });

  it("does not expose contextual tabs on unrelated routes", () => {
    expect(resolveTopShellTabSet("/one/profile")).toBeNull();
  });

  it("uses the same AppTopShell tab contract for public knowledge routes", () => {
    expect(
      resolvePublicKnowledgeTopShellTabSet("/welcome?tab=research"),
    ).toMatchObject({
      label: "Explore",
      activeValue: "research",
    });
    expect(
      resolvePublicKnowledgeTopShellTabSet("/welcome?tab=developers"),
    ).toMatchObject({
      activeValue: "developers",
    });
    expect(
      resolvePublicKnowledgeTopShellTabSet("/welcome?tab=unknown"),
    ).toBeNull();
    expect(
      resolvePublicKnowledgeTopShellTabSet("/research/protocol"),
    ).toBeNull();
    expect(resolvePublicKnowledgeTopShellTabSet("/blog/a-post")).toBeNull();
    expect(resolvePublicKnowledgeTopShellTabSet("/developers/api")).toBeNull();
    expect(resolvePublicKnowledgeTopShellTabSet("/developers")).toMatchObject({
      activeValue: "developers",
    });
    expect(resolveTopShellTabSet("/research")).toMatchObject({
      label: "Explore",
      activeValue: "research",
    });
    expect(
      resolveTopShellRouteProfile("/welcome?tab=blog").model,
    ).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "public", activeValue: "blog" },
    });
    expect(resolveTopShellRouteProfile("/blog").model).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "public", activeValue: "blog" },
    });
    expect(resolveTopShellRouteProfile("/research").model).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "public", activeValue: "research" },
    });
    expect(resolveTopShellRouteProfile("/developers").model).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "public", activeValue: "developers" },
    });
    expect(resolveTopShellTabSet("/research/")).toMatchObject({
      id: "public",
      activeValue: "research",
    });
  });

  it("keeps static-export Location hub routes out of the shared top shell", () => {
    expect(resolveTopShellTabSet("/one/location/?view=links")).toBeNull();
    expect(
      resolveTopShellRouteProfile("/one/location/?view=inbox").model,
    ).toMatchObject({
      mode: "bar",
    });
  });

  it.each([
    ["/login", "hidden"],
    ["/one/profile", "bar"],
    ["/one/location?action=share", "bar"],
    ["/one/location?view=people", "bar"],
    ["/one/kai?tab=analysis", "bar"],
    ["/one/consent?tab=history", "bar"],
    ["/ria/picks", "bar"],
  ] as const)("resolves %s as %s", (routeKey, expectedMode) => {
    const profile = resolveTopShellRouteProfile(routeKey);
    expect(profile.model.mode).toBe(expectedMode);
    expect(profile.metrics.hasTabs).toBe(expectedMode === "bar-with-tabs");
    expect(profile.metrics.shellVisible).toBe(expectedMode !== "hidden");
  });

  it("keeps the One brand visible for the canonical native and web One home routes", () => {
    expect(resolveTopShellRouteProfile("/one").model).toMatchObject({
      mode: "bar",
      brand: "one",
    });
    expect(resolveTopShellRouteProfile("/one/").model).toMatchObject({
      mode: "bar",
      brand: "one",
    });
    expect(
      resolveTopShellRouteProfile("/one/location").model,
    ).not.toHaveProperty("brand");
  });
});
