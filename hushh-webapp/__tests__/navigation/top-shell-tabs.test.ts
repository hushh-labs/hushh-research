import { describe, expect, it } from "vitest";

import {
  resolvePublicKnowledgeTopShellTabSet,
  resolveTopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";

describe("top shell contextual tabs", () => {
  it("uses route state as the selection authority for Location", () => {
    expect(resolveTopShellTabSet("/one/location")).toMatchObject({
      label: "Location",
      activeValue: "now",
    });
    expect(resolveTopShellTabSet("/one/location?view=inbox")).toMatchObject({
      // Legacy Inbox links land on the canonical Now tab; focused action
      // parameters are resolved by the Location hub after route settlement.
      activeValue: "now",
    });
    expect(resolveTopShellTabSet("/one/location?action=share")).toBeNull();
    expect(resolveTopShellTabSet("/one/location/map")).toBeNull();
  });

  it("uses route state as the selection authority for Finance", () => {
    expect(resolveTopShellTabSet("/one/kai")).toMatchObject({
      label: "Finance",
      activeValue: "market",
    });
    expect(resolveTopShellTabSet("/one/kai?tab=analysis")).toMatchObject({
      activeValue: "analysis",
    });
    expect(resolveTopShellTabSet("/one/kai/?tab=portfolio")).toMatchObject({
      id: "finance",
      activeValue: "portfolio",
    });
    expect(resolveTopShellTabSet("/one/kai/portfolio/holdings")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/allocation")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/performance")).toBeNull();
    expect(resolveTopShellTabSet("/one/kai/portfolio/sources")).toBeNull();
    expect(
      resolveTopShellRouteProfile("/one/kai/?tab=analysis").model,
    ).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "finance", activeValue: "analysis" },
    });
  });

  it("moves Consent Center state into the shared top shell", () => {
    const tabs = resolveTopShellTabSet(
      "/one/consent?tab=history&q=tax&page=3&requestId=req_123&from=%2Fone",
    );

    expect(tabs).toMatchObject({
      id: "consent",
      label: "Consent Center",
      activeValue: "history",
    });
    expect(tabs?.tabs.find((tab) => tab.value === "active")?.href).toBe(
      "/one/consent?tab=active&from=%2Fone",
    );
    expect(
      resolveTopShellRouteProfile("/one/consent?tab=connections").model,
    ).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "consent", activeValue: "connections" },
    });
    expect(resolveTopShellTabSet("/one/consent/?tab=active")).toMatchObject({
      id: "consent",
      activeValue: "active",
    });
  });

  it("renders RIA workspace tabs through the same fixed top shell", () => {
    expect(resolveTopShellTabSet("/ria")).toMatchObject({
      id: "ria",
      label: "RIA workspace",
      activeValue: "home",
    });
    expect(resolveTopShellTabSet("/ria/clients")).toMatchObject({
      id: "ria",
      activeValue: "clients",
    });
    expect(resolveTopShellTabSet("/ria/picks")).toMatchObject({
      id: "ria",
      activeValue: "picks",
    });
    expect(resolveTopShellRouteProfile("/ria/clients").model).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "ria", activeValue: "clients" },
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
    ).toMatchObject({
      label: "Explore",
      activeValue: "research",
    });
    expect(resolvePublicKnowledgeTopShellTabSet("/blog/a-post")).toMatchObject({
      activeValue: "blog",
    });
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

  it("keeps static-export Location tabs in the shared top shell", () => {
    expect(resolveTopShellTabSet("/one/location/?view=links")).toMatchObject({
      id: "location",
      activeValue: "links",
    });
    expect(
      resolveTopShellRouteProfile("/one/location/?view=inbox").model,
    ).toMatchObject({
      mode: "bar-with-tabs",
      tabs: { id: "location", activeValue: "now" },
    });
  });

  it.each([
    ["/login", "hidden"],
    ["/one/profile", "bar"],
    ["/one/location?action=share", "bar"],
    ["/one/location?view=people", "bar-with-tabs"],
    ["/one/kai?tab=analysis", "bar-with-tabs"],
    ["/one/consent?tab=history", "bar-with-tabs"],
    ["/ria/picks", "bar-with-tabs"],
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
