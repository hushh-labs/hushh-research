import surfaceMap from "@/frontend-native-surface-map.generated.json";
import { APP_ROUTE_LAYOUT_CONTRACT, resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { PUBLIC_ROUTES, PUBLIC_ROUTE_SEMANTICS } from "@/lib/seo/site";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { describe, expect, it } from "vitest";

describe("One route voice playbooks", () => {
  it("authors exactly one bounded playbook for every physical route", () => {
    const physicalRoutes = surfaceMap.routes
      .filter((entry) => entry.physical_page_exists)
      .map((entry) => entry.route)
      .sort();
    const authoredRoutes = APP_ROUTE_LAYOUT_CONTRACT.map((entry) => entry.route).sort();

    expect(authoredRoutes).toEqual(physicalRoutes);
    expect(new Set(authoredRoutes).size).toBe(authoredRoutes.length);
    for (const entry of APP_ROUTE_LAYOUT_CONTRACT) {
      expect(entry.voicePlaybook.playbookId).toMatch(/^route\./);
      expect(entry.voicePlaybook.purpose.length).toBeGreaterThan(0);
      expect(entry.voicePlaybook.screen).toBe(deriveVoiceRouteScreen(entry.route).screen);
      expect(entry.voicePlaybook.completionBoundary.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.interactionLayerPolicy.allowedFamilies)).toBe(true);
      if (entry.voicePlaybook.proactivity === "on_entry") {
        expect(entry.voicePlaybook.entryCue.length).toBeGreaterThan(0);
        expect(entry.voicePlaybook.primaryActionId).toBeTruthy();
      }
    }
    expect(resolveAppRouteLayout("/login").interactionLayerPolicy.allowedFamilies).toEqual([
      "legal_document",
    ]);
    expect(
      resolveAppRouteLayout("/register-phone").interactionLayerPolicy.allowedFamilies,
    ).toEqual(["country_picker"]);
  });

  it("prefers exact setup routes before the dynamic capability pattern", () => {
    expect(resolveAppRouteLayout("/one/setup/kai").route).toBe("/one/setup/kai");
    expect(resolveAppRouteLayout("/one/setup/finance").route).toBe(
      "/one/setup/[capability]"
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
