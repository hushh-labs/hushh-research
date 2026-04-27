import { describe, expect, it } from "vitest";

import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  getKaiActionsForControlId,
  KAI_ACTION_GATEWAY,
  searchKaiActions,
} from "@/lib/voice/kai-action-gateway";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function makeRuntimeState(overrides: Partial<AppRuntimeState> = {}): AppRuntimeState {
  return {
    auth: {
      signed_in: true,
      user_id: "user_1",
      ...(overrides.auth || {}),
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
      ...(overrides.vault || {}),
    },
    route: {
      pathname: "/kai",
      screen: "kai_market",
      subview: null,
      ...(overrides.route || {}),
    },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
      ...(overrides.runtime || {}),
    },
    portfolio: {
      has_portfolio_data: true,
      ...(overrides.portfolio || {}),
    },
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
      transition_target: null,
      ria_switch_available: false,
      ria_setup_available: false,
      ...(overrides.persona || {}),
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
      ...(overrides.voice || {}),
    },
  };
}

describe("kai-action-gateway", () => {
  it("loads the generated gateway with stable action identity", () => {
    expect(KAI_ACTION_GATEWAY.schema_version).toBe("kai.action_gateway.vnext");
    const ids = KAI_ACTION_GATEWAY.actions.map((action) => action.action_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(KAI_ACTION_GATEWAY.source_contracts?.length).toBeGreaterThan(0);
    const reservedNavPrefix = ["nav", ""].join(".");
    expect(ids.every((id) => !id.startsWith(reservedNavPrefix))).toBe(true);
    expect(
      KAI_ACTION_GATEWAY.actions.every((action) =>
        ["one", "kai", "nav"].includes(action.speaker_persona)
      )
    ).toBe(true);
    expect(getKaiActionById("route.kai_dashboard")?.speaker_persona).toBe("kai");
    expect(getKaiActionById("route.consents")?.speaker_persona).toBe("nav");
    expect(getKaiActionById("route.profile")?.speaker_persona).toBe("one");
  });

  it("maps control ids and authored workflows back to canonical actions", () => {
    const activeAnalysisActions = getKaiActionsForControlId("analysis_open_active");
    expect(activeAnalysisActions.map((action) => action.action_id)).toContain("analysis.resume_active");

    const riaHome = getKaiActionById("route.ria_home");
    expect(riaHome).not.toBeNull();
    expect(riaHome?.workflow?.workflow_id).toBe("route.ria_home.entry");
    expect(riaHome?.workflow?.steps).toEqual([
      expect.objectContaining({
        type: "persona_switch",
        target_persona: "ria",
        confirmation_required: true,
      }),
      expect.objectContaining({
        type: "route_switch",
        href: "/ria",
      }),
    ]);
  });

  it("maps the RIA flow with direct navigation and guarded manual actions", () => {
    const riaActions = KAI_ACTION_GATEWAY.actions.filter(
      (action) => action.surface_id.startsWith("ria_") || action.action_id.includes(".ria.")
    );
    expect(riaActions.map((action) => action.action_id)).toEqual(
      expect.arrayContaining([
        "route.ria_home",
        "route.ria_onboarding",
        "route.ria_clients",
        "route.ria_picks",
        "route.ria_marketplace_connect",
        "ria.picks.open_source_kai",
        "ria.picks.open_source_my",
        "ria.picks.save_package",
        "ria.client_workspace.open_access_tab",
        "ria.client_workspace.request_access",
        "marketplace.ria.request_advisory",
      ])
    );

    const riaHome = getKaiActionById("route.ria_home");
    expect(riaHome).toEqual(
      expect.objectContaining({
        action_id: "route.ria_home",
        surface_id: "ria_home",
        speaker_persona: "one",
        risk_level: "medium",
        execution_policy: "allow_direct",
        guard_ids: ["auth_signed_in", "ria_persona_available"],
        execution_target: {
          status: "wired",
          path: "route",
          target: "/ria",
        },
      })
    );
    expect(riaHome?.reachability).toEqual(
      expect.objectContaining({
        routes: ["/ria"],
        screens: ["ria_home"],
        hidden_navigable: true,
        active_personas: ["ria"],
        requires_persona_switch_confirmation: true,
      })
    );
    expect(riaHome?.workflow).toEqual(
      expect.objectContaining({
        workflow_id: "route.ria_home.entry",
        confirmation_required: true,
        blocked_guidance: "Complete or unlock RIA setup before entering the RIA workspace.",
      })
    );

    expect(getKaiActionById("route.ria_clients")).toEqual(
      expect.objectContaining({
        action_id: "route.ria_clients",
        execution_policy: "allow_direct",
        execution_target: {
          status: "wired",
          path: "route",
          target: "/ria/clients",
        },
      })
    );
    expect(getKaiActionById("ria.picks.open_source_kai")?.execution_target).toEqual({
      status: "wired",
      path: "route",
      target: "/ria/picks?source=kai",
    });
    expect(getKaiActionById("ria.picks.save_package")).toEqual(
      expect.objectContaining({
        risk_level: "high",
        execution_policy: "manual_only",
        execution_target: expect.objectContaining({
          status: "unwired",
        }),
      })
    );
    expect(getKaiActionById("marketplace.ria.request_advisory")).toEqual(
      expect.objectContaining({
        risk_level: "high",
        execution_policy: "manual_only",
        execution_target: expect.objectContaining({
          status: "unwired",
        }),
      })
    );
  });

  it("requires an explicit persona switch for earned RIA actions", () => {
    const action = getKaiActionById("route.ria_home");
    const availability = evaluateKaiActionAvailability({
      action: action!,
      appRuntimeState: makeRuntimeState({
        persona: {
          active: "investor",
          primary_nav: "investor",
          available: ["investor", "ria"],
          transition_target: null,
          ria_switch_available: true,
          ria_setup_available: true,
        },
      }),
    });

    expect(availability).toEqual({
      status: "requires_persona_switch",
      reason: "Switch to RIA workspace first.",
      target_persona: "ria",
      blocked_guidance: "Complete or unlock RIA setup before entering the RIA workspace.",
    });
  });

  it("blocks locked RIA actions with guidance instead of exposing them as executable", () => {
    const action = getKaiActionById("route.ria_home");
    const availability = evaluateKaiActionAvailability({
      action: action!,
      appRuntimeState: makeRuntimeState({
        persona: {
          active: "investor",
          primary_nav: "investor",
          available: ["investor"],
          transition_target: null,
          ria_switch_available: false,
          ria_setup_available: true,
        },
      }),
    });

    expect(availability).toEqual({
      status: "blocked",
      reason: "RIA actions stay locked until you finish RIA setup.",
      target_persona: "ria",
      blocked_guidance: "Complete or unlock RIA setup before entering the RIA workspace.",
    });
  });

  it("keeps typed search on the same action plane as voice and guard filtering", () => {
    const dashboardResults = searchKaiActions({
      query: "dashboard",
      appRuntimeState: makeRuntimeState(),
    });
    expect(dashboardResults[0]?.action.action_id).toBe("route.kai_dashboard");
    expect(dashboardResults[0]?.availability.status).toBe("available");

    const riaResults = searchKaiActions({
      query: "ria",
      appRuntimeState: makeRuntimeState({
        persona: {
          active: "investor",
          primary_nav: "investor",
          available: ["investor", "ria"],
          transition_target: null,
          ria_switch_available: true,
          ria_setup_available: true,
        },
      }),
    });
    expect(riaResults.some((entry) => entry.action.action_id === "route.ria_home")).toBe(true);
    expect(
      riaResults.find((entry) => entry.action.action_id === "route.ria_home")?.availability.status
    ).toBe("requires_persona_switch");
  });
});
