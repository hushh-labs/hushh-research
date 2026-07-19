import index from "@/contracts/kai/one-route-orchestration-index.v1.json";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { describe, expect, it } from "vitest";

describe("One route orchestration index", () => {
  it("covers each physical route exactly once with bounded metadata", () => {
    expect(index.schema_version).toBe("one.route_orchestration_index.v2");
    expect(index.routes.length).toBeGreaterThan(0);
    expect(new Set(index.routes.map((entry) => entry.route_pattern)).size).toBe(
      index.routes.length,
    );
    expect(
      index.routes.every(
        (entry) => entry.instruction_id && entry.context_policy,
      ),
    ).toBe(true);
    expect(
      index.routes.every((entry) => entry.voice_playbook?.playbook_id),
    ).toBe(true);
  });

  it("keeps generic sign-in off Login while retaining explicit provider actions", () => {
    const login = index.routes.find(
      (entry) => entry.route_pattern === "/login",
    );
    expect(login?.action_ids).toEqual([
      "auth.close_legal",
      "auth.open_privacy",
      "auth.open_terms",
      "auth.sign_in_apple",
      "auth.sign_in_google",
      "onboarding.back_to_intro",
    ]);
  });

  it("keeps every generated executable route action aligned with a canonical screen", () => {
    const mismatches: string[] = [];
    for (const route of index.routes) {
      const canonicalScreen = deriveVoiceRouteScreen(
        route.route_pattern,
      ).screen;
      for (const actionId of route.action_ids) {
        const action = getKaiActionById(actionId);
        const routeIsTheActionSurface =
          action?.reachability.routes.length === 1 &&
          action.reachability.routes[0] === route.route_pattern;
        if (!routeIsTheActionSurface) continue;
        if (!action) {
          mismatches.push(`${route.route_pattern}: missing ${actionId}`);
          continue;
        }
        if (!action.reachability.screens.includes(canonicalScreen)) {
          mismatches.push(
            `${route.route_pattern}: ${actionId} lacks canonical screen ${canonicalScreen}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("indexes the root welcome as a published, generated action surface", () => {
    const root = index.routes.find((entry) => entry.route_pattern === "/");
    expect(root).toMatchObject({
      instruction_id: "route.one.intro",
      context_policy: "publish",
      action_ids: ["onboarding.claim_one"],
      delegation_policy: { mode: "no_delegation" },
    });
    expect(root?.voice_playbook).toMatchObject({
      screen: "one_intro",
      primary_action_id: "onboarding.claim_one",
      proactivity: "on_entry",
    });
  });

  it("keeps the dynamic compatibility route transitional and attributes Finance to its static contract", () => {
    const compatibility = index.routes.find(
      (entry) => entry.route_pattern === "/one/setup/[capability]",
    );
    expect(compatibility?.orchestration_class).toBe("transitional");
    expect(compatibility?.action_ids).toEqual([]);

    const finance = index.routes.find(
      (entry) => entry.route_pattern === "/one/setup/finance",
    );
    expect(finance?.canonical_screen).toBe("one_setup_finance");
    expect(finance?.voice_contract_file).toContain(
      "app/one/setup/kai/page.voice-action-contract.json",
    );
  });

  it("admits Location delegation only from its declared route", () => {
    const location = index.routes.find(
      (entry) => entry.route_pattern === "/one/location",
    );
    const profile = index.routes.find(
      (entry) => entry.route_pattern === "/one/profile",
    );
    expect(location?.delegation_policy).toEqual({
      mode: "one_action_gate",
      allowed_delegate_agent_ids: ["agent_location"],
    });
    expect(profile?.delegation_policy.mode).toBe("no_delegation");
  });
});
