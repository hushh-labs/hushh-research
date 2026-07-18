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
      activeValue: "inbox",
    });
    expect(resolveTopShellTabSet("/one/location?action=share")).toBeNull();
  });

  it("uses route state as the selection authority for Finance", () => {
    expect(resolveTopShellTabSet("/one/kai")).toMatchObject({
      label: "Finance",
      activeValue: "market",
    });
    expect(resolveTopShellTabSet("/one/kai?tab=analysis")).toMatchObject({
      activeValue: "analysis",
    });
  });

  it("does not expose contextual tabs on unrelated routes", () => {
    expect(resolveTopShellTabSet("/profile")).toBeNull();
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
  });

  it.each([
    ["/login", "hidden"],
    ["/profile", "bar"],
    ["/one/location?action=share", "bar"],
    ["/one/location?view=people", "bar-with-tabs"],
    ["/one/kai?tab=analysis", "bar-with-tabs"],
  ] as const)("resolves %s as %s", (routeKey, expectedMode) => {
    const profile = resolveTopShellRouteProfile(routeKey);
    expect(profile.model.mode).toBe(expectedMode);
    expect(profile.metrics.hasTabs).toBe(expectedMode === "bar-with-tabs");
    expect(profile.metrics.shellVisible).toBe(expectedMode !== "hidden");
  });

  it("limits the One brand to the One home route", () => {
    expect(resolveTopShellRouteProfile("/one").model).toMatchObject({
      mode: "bar",
      brand: "one",
    });
    expect(
      resolveTopShellRouteProfile("/one/location").model,
    ).not.toHaveProperty("brand");
  });
});
