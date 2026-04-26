import { describe, expect, it } from "vitest";

import { resolveGroundedVoicePlan, VOICE_MANUAL_ONLY_MESSAGE } from "@/lib/voice/voice-grounding";
import type { StructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type { AppRuntimeState, VoiceResponse } from "@/lib/voice/voice-types";

function makeContext(pathname: string): StructuredScreenContext {
  return {
    route: {
      pathname,
      screen: "profile",
      subview: null,
      page_title: null,
      nav_stack: [],
    },
    ui: {
      visible_modules: [],
      active_filters: [],
      selected_objects: [],
    },
    runtime: {
      busy_operations: [],
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
    },
    auth: {
      signed_in: true,
      user_id: "user_1",
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
    },
  };
}

function makeRuntimeState(
  pathname: string,
  overrides: Partial<AppRuntimeState> = {}
): AppRuntimeState {
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
      pathname,
      screen: pathname.startsWith("/profile")
        ? "profile_account"
        : pathname.startsWith("/kai/analysis")
          ? "kai_analysis"
          : pathname.startsWith("/kai/optimize")
            ? "kai_optimize"
            : pathname.startsWith("/kai")
              ? "kai_market"
              : "profile_account",
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

describe("resolveGroundedVoicePlan", () => {
  it("keeps destructive intents manual-only with no execution steps", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Please do that yourself in the app.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "delete my account",
      response,
      structuredContext: makeContext("/profile"),
    });

    expect(plan.status).toBe("manual_only");
    expect(plan.actionId).toBe("profile.delete_account");
    expect(plan.actionLabel).toBe("Delete Account");
    expect(plan.destructive).toBe(true);
    expect(plan.message).toBe(VOICE_MANUAL_ONLY_MESSAGE);
    expect(plan.execution.mode).toBe("manual_only");
    expect(plan.execution.steps).toHaveLength(1);
    expect(plan.execution.steps[0]).toEqual({
      type: "prompt",
      message: VOICE_MANUAL_ONLY_MESSAGE,
      reason: "destructive_action_policy",
    });
  });

  it("grounds hidden navigable actions as navigation followed by a single action", () => {
    const response: VoiceResponse = {
      kind: "execute",
      message: "Resuming your active analysis.",
      speak: true,
      tool_call: {
        tool_name: "resume_active_analysis",
        args: {},
      },
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "resume my active analysis",
      response,
      structuredContext: makeContext("/kai"),
      appRuntimeState: makeRuntimeState("/kai", {
        runtime: {
          analysis_active: true,
          analysis_ticker: "NVDA",
          analysis_run_id: "run_1",
          import_active: false,
          import_run_id: null,
          busy_operations: [],
        },
      }),
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("analysis.resume_active");
    expect(plan.actionLabel).toBe("Resume Active Analysis Run");
    expect(plan.destructive).toBe(false);
    expect(plan.message).toBeNull();
    expect(plan.execution.mode).toBe("navigate_then_action");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/kai/analysis",
        reason: "hidden_action_navigation_prerequisite",
        settlementTarget: {
          route: "/kai/analysis",
          screen: "kai_analysis",
        },
      },
      {
        type: "tool_call",
        toolCall: {
          tool_name: "resume_active_analysis",
          args: {},
        },
        reason: "wired_tool_after_navigation",
      },
    ]);
  });

  it("grounds optimize command responses to the live optimize route", () => {
    const response: VoiceResponse = {
      kind: "execute",
      message: "Optimizing now.",
      speak: true,
      tool_call: {
        tool_name: "execute_kai_command",
        args: {
          command: "optimize",
        },
      },
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "optimize",
      response,
      structuredContext: makeContext("/kai/portfolio"),
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("route.kai_optimize");
    expect(plan.actionLabel).toBe("Open Optimize Surface");
    expect(plan.destructive).toBe(false);
    expect(plan.message).toBeNull();
    expect(plan.execution.mode).toBe("navigate_only");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/kai/optimize",
        reason: "route_bound_action",
        settlementTarget: {
          route: "/kai/optimize",
          screen: "kai_optimize",
        },
      },
    ]);
  });

  it("grounds direct analysis navigation from transcript fallback", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Opening analysis.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "take me to analysis",
      response,
      structuredContext: makeContext("/profile"),
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("route.kai_analysis");
    expect(plan.execution.mode).toBe("navigate_only");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/kai/analysis",
        reason: "route_bound_action",
        settlementTarget: {
          route: "/kai/analysis",
          screen: "kai_analysis",
        },
      },
    ]);
    expect(plan.resolutionSource).toBe("transcript");
  });

  it("keeps ambiguous clarify responses in the ambiguity fallback", () => {
    const response: VoiceResponse = {
      kind: "clarify",
      reason: "ticker_ambiguous",
      message: "Did you mean NVDA or AMD?",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "analyze it",
      response,
      structuredContext: makeContext("/kai/analysis"),
    });

    expect(plan.status).toBe("ambiguous");
    expect(plan.actionId).toBeNull();
    expect(plan.actionLabel).toBeNull();
    expect(plan.destructive).toBe(false);
    expect(plan.message).toBe("Did you mean NVDA or AMD?");
    expect(plan.execution.mode).toBe("ambiguous");
    expect(plan.execution.steps).toHaveLength(0);
  });

  it("prioritizes planner-grounded action over transcript heuristic when they diverge", () => {
    const response: VoiceResponse = {
      kind: "execute",
      message: "Opening dashboard.",
      speak: true,
      tool_call: {
        tool_name: "execute_kai_command",
        args: {
          command: "dashboard",
        },
      },
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "open gmail receipts",
      response,
      structuredContext: makeContext("/kai"),
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("route.kai_dashboard");
    expect(plan.execution.mode).toBe("direct_tool");
    expect(plan.execution.steps).toEqual([
      {
        type: "tool_call",
        toolCall: {
          tool_name: "execute_kai_command",
          args: {
            command: "dashboard",
          },
        },
        reason: "wired_tool_action",
      },
    ]);
  });

  it("grounds PKM navigation from transcript heuristics even for speak-only replies", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Opening PKM Agent Lab.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "open pkm",
      response,
      structuredContext: makeContext("/profile"),
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("route.profile_pkm_agent_lab");
    expect(plan.execution.mode).toBe("navigate_only");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/profile/pkm-agent-lab",
        reason: "route_bound_action",
        settlementTarget: {
          route: "/profile/pkm-agent-lab",
          screen: "profile_pkm_agent_lab",
        },
      },
    ]);
    expect(plan.resolutionSource).toBe("transcript");
  });

  it("prefers the canonical planner action id over transcript heuristics", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Opening profile.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "open gmail receipts",
      response,
      structuredContext: makeContext("/kai"),
      canonicalActionId: "route.profile",
    });

    expect(plan.status).toBe("resolved");
    expect(plan.actionId).toBe("route.profile");
    expect(plan.resolutionSource).toBe("canonical");
    expect(plan.execution.mode).toBe("direct_tool");
    expect(plan.execution.steps).toEqual([
      {
        type: "tool_call",
        toolCall: {
          tool_name: "execute_kai_command",
          args: {
            command: "profile",
          },
        },
        reason: "wired_tool_action",
      },
    ]);
  });

  it("fails closed when the planner sends an unknown canonical action id", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Opening Gmail.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "open gmail",
      response,
      structuredContext: makeContext("/kai"),
      canonicalActionId: "route.not_real",
    });

    expect(plan.status).toBe("unavailable");
    expect(plan.actionId).toBe("route.not_real");
    expect(plan.actionLabel).toBeNull();
    expect(plan.resolutionSource).toBe("canonical");
    expect(plan.execution.mode).toBe("unavailable");
    expect(plan.execution.steps).toEqual([
      {
        type: "prompt",
        message: "I can’t do that right now.",
        reason: "canonical_action_not_found",
      },
    ]);
  });

  it("disables heuristic compatibility fallback when explicitly requested", () => {
    const response: VoiceResponse = {
      kind: "speak_only",
      message: "Opening PKM Agent Lab.",
      speak: true,
    };

    const plan = resolveGroundedVoicePlan({
      transcript: "open pkm",
      response,
      structuredContext: makeContext("/profile"),
      allowCompatibilityFallback: false,
    });

    expect(plan.status).toBe("none");
    expect(plan.actionId).toBeNull();
    expect(plan.resolutionSource).toBe("none");
    expect(plan.execution.steps).toHaveLength(0);
  });
});
