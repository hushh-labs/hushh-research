import surfaceMap from "@/frontend-native-surface-map.generated.json";
import { APP_ROUTE_LAYOUT_CONTRACT, resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { PUBLIC_ROUTES, PUBLIC_ROUTE_SEMANTICS } from "@/lib/seo/site";
import { deriveVoiceRouteScreen } from "@/lib/kai/actions/route-screen-derivation";
import { describe, expect, it } from "vitest";
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { TOP_SHELL_TAB_REGISTRY } from "@/lib/navigation/top-shell-tabs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("One route voice playbooks", () => {
  it("includes canonical query-backed views in the native surface map", () => {
    const topology = JSON.parse(readFileSync(resolve(process.cwd(), "../config/runtime-topology-maintenance.json"), "utf8"));
    const expected = topology.semantic_routes.filter((route: { lifecycle: string }) => route.lifecycle === "canonical")
      .map((route: { id: string; canonical_url: string }) => [route.id, route.canonical_url]);
    const views = (surfaceMap as unknown as { semantic_views?: { id: string; route: string }[] }).semantic_views ?? [];
    expect(views.map(view => [view.id, view.route])).toEqual(expected);
    expect(views.some(view => view.route === "/one/kai?tab=portfolio")).toBe(true);
    const paths = new Set(views.map(view => view.route));
    for (const definition of Object.values(TOP_SHELL_TAB_REGISTRY)) {
      if (!definition.queryParam) continue;
      for (const tab of definition.tabs) {
        const url = new URL(tab.href, "https://example.invalid");
        url.searchParams.set(definition.queryParam, tab.value);
        expect(paths.has(`${url.pathname}${url.search}`), `${definition.id}:${tab.value}`).toBe(true);
      }
    }
  });
  it.each([["", "Setup", "/one/setup"], ["from=%2Fone%2Fprofile%2Fhosting", "Hosting", "/one/profile/hosting"]])("preserves the cloud visit parent (%s)", (query, label, href) => {
    const breadcrumb = resolveTopShellBreadcrumb("/one/setup/cloud", new URLSearchParams(query));
    expect(breadcrumb?.items[1]).toEqual({ label, href });
    expect(breadcrumb?.backHref).toBe(href);
    const playbook = resolveAppRouteLayout("/one/setup/cloud").voicePlaybook;
    expect(playbook.primaryActionId).toBe("setup.finish_cloud");
  });

  it("authors exactly one bounded playbook for every physical route", () => {
    const physicalRoutes = surfaceMap.routes
      .filter(
        (entry) =>
          entry.physical_page_exists || entry.route_contract?.mode === "redirect",
      )
      .map((entry) => entry.route)
      .sort();
    const authoredRoutes = APP_ROUTE_LAYOUT_CONTRACT.map(
      (entry) => entry.route,
    ).sort();

    expect(authoredRoutes).toEqual(physicalRoutes);
    expect(new Set(authoredRoutes).size).toBe(authoredRoutes.length);
    const screenMismatches: string[] = [];
    for (const entry of APP_ROUTE_LAYOUT_CONTRACT) {
      expect(entry.voicePlaybook.playbookId).toMatch(/^route\./);
      expect(entry.voicePlaybook.purpose.length).toBeGreaterThan(0);
      const derivedScreen = deriveVoiceRouteScreen(entry.route, undefined, {
        authenticated: true,
      }).screen;
      if (entry.voicePlaybook.screen !== derivedScreen) {
        screenMismatches.push(
          `${entry.route}: authored=${entry.voicePlaybook.screen} derived=${derivedScreen}`,
        );
      }
      expect(entry.voicePlaybook.completionBoundary.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.interactionLayerPolicy.allowedFamilies)).toBe(true);
      if (entry.voicePlaybook.proactivity === "on_entry") {
        expect(entry.voicePlaybook.entryCue.length).toBeGreaterThan(0);
        expect(entry.voicePlaybook.primaryActionId).toBeTruthy();
      }
    }
    expect(screenMismatches).toEqual([]);
    // Terms and Privacy leave Login for their own pages; no legal overlay.
    expect(resolveAppRouteLayout("/login").interactionLayerPolicy.allowedFamilies).toEqual([]);
    expect(
      resolveAppRouteLayout("/register-phone").interactionLayerPolicy.allowedFamilies,
    ).toEqual(["country_picker"]);
    expect(
      resolveAppRouteLayout("/one/setup/location").interactionLayerPolicy.allowedFamilies,
    ).toEqual(["vault_setup"]);
    expect(resolveAppRouteLayout("/one/location").interactionLayerPolicy.allowedFamilies).toEqual([
      "vault_setup",
    ]);
  });

  it("prefers exact setup routes before the dynamic capability pattern", () => {
    expect(resolveAppRouteLayout("/one/setup/kai").route).toBe("/one/setup/kai");
    expect(resolveAppRouteLayout("/one/setup/finance").route).toBe(
      "/one/setup/finance"
    );
  });

  it("aligns public SEO/AEO semantics by route identity without publishing runtime prompts", () => {
    for (const route of PUBLIC_ROUTES) {
      const layout = resolveAppRouteLayout(route);
      expect(PUBLIC_ROUTE_SEMANTICS[route].voicePlaybookId).toBe(
        layout.voicePlaybook.playbookId,
      );
      expect(PUBLIC_ROUTE_SEMANTICS[route].description).not.toContain(
        layout.voicePlaybook.recoveries.failed,
      );
    }
  });
});
