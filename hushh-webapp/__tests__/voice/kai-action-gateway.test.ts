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
  });

  it("maps control ids and authored workflows back to canonical actions", () => {
    const activeAnalysisActions = getKaiActionsForControlId("analysis_open_active");
    expect(activeAnalysisActions.map((action) => action.action_id)).toContain("analysis.resume_active");

    const riaHome = getKaiActionById("nav.ria_home");
    expect(riaHome).not.toBeNull();
    expect(riaHome?.workflow?.workflow_id).toBe("nav.ria_home.entry");
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

  it("requires an explicit persona switch for earned RIA actions", () => {
    const action = getKaiActionById("nav.ria_home");
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
    const action = getKaiActionById("nav.ria_home");
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
    expect(dashboardResults[0]?.action.action_id).toBe("nav.kai_dashboard");
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
    expect(riaResults.some((entry) => entry.action.action_id === "nav.ria_home")).toBe(true);
    expect(
      riaResults.find((entry) => entry.action.action_id === "nav.ria_home")?.availability.status
    ).toBe("requires_persona_switch");
  });
});
