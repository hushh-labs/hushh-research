import { describe, expect, it } from "vitest";

import {
  deriveVoiceCapabilityState,
  projectKaiActionCapability,
} from "@/lib/voice/capability-projection";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function runtime(overrides: Partial<AppRuntimeState> = {}): AppRuntimeState {
  return {
    auth: { signed_in: true, user_id: "user_1" },
    vault: { unlocked: true, token_available: true, token_valid: true },
    route: { pathname: "/one", screen: "one_agents", subview: null },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: { has_portfolio_data: false },
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
      transition_target: null,
      ria_switch_available: false,
      ria_setup_available: false,
    },
    voice: { available: false, tts_playing: false, last_tool_name: null, last_ticker: null },
    ...overrides,
  };
}

function snapshot(overrides: Partial<OneVoiceContextSnapshot> = {}): OneVoiceContextSnapshot {
  return {
    schema_version: "one_voice_context.v1",
    snapshot_id: "ctx_test",
    revisions: { route: "route_1", ui: "ui_1", cache: "cache_1", persona: "persona_1", voice: 1 },
    route: { screen: "one_agents", playbook_id: "one", subview: null, route_family: "/one", nav_stack: ["/one"] },
    ui: { visible_modules: [], visible_control_ids: [], selected_entity_present: false },
    available_action_ids: [],
    pending_settlement: false,
    cache: { vault_ready: true, portfolio_ready: false, busy_operations: [], freshness: "fresh_or_stale_safe" },
    persona: { active: "investor", primary_nav: "investor", available: ["investor"] },
    onboarding: {
      phase: "root_completion",
      root_resolved: true,
      return_route: "/one/setup",
      phone_verified: true,
      callback_state: "none",
      setup_capability_ids: [],
    },
    voice: { state: "idle", transition_seq: 1 },
    world_model: { summary_available: false, mode: "redacted_summary_only" },
    privacy: { redacted: true, excludes: [] },
    ...overrides,
  };
}

function project(actionId: string, app = runtime(), context = snapshot()) {
  return projectKaiActionCapability({
    actionId,
    state: deriveVoiceCapabilityState({ appRuntimeState: app, snapshot: context }),
  });
}

describe("capability projection", () => {
  it("makes Claim One terminal after sign-in or resolved setup", () => {
    expect(project("onboarding.claim_one").status).toBe("terminal");
  });

  it("exposes only the active phone stage", () => {
    const phone = snapshot({
      onboarding: {
        phase: "phone_required",
        root_resolved: false,
        return_route: "/one/setup",
        phone_verified: false,
        callback_state: "none",
        setup_capability_ids: [],
      },
      available_action_ids: ["phone_mandate.submit_number"],
    });
    expect(project("phone_mandate.submit_number", runtime(), phone).status).toBe("input_needed");
    expect(project("phone_mandate.submit_code", runtime(), phone).status).toBe("blocked");
  });

  it("treats an off-screen analysis request as a journey, not a direct control", () => {
    expect(project("analysis.start").status).toBe("cross_surface_journey");
  });

  it("keeps completed setup acknowledgement terminal", () => {
    expect(project("setup.hub_master_ack").status).toBe("terminal");
  });
});
