import { describe, expect, it } from "vitest";

import { resolveGroundedVoicePlan, VOICE_MANUAL_ONLY_MESSAGE } from "@/lib/voice/voice-grounding";
import type { StructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type { VoiceResponse } from "@/lib/voice/voice-types";

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
    expect(plan.actionId).toBe("nav.kai_optimize");
    expect(plan.actionLabel).toBe("Open Optimize Surface");
    expect(plan.destructive).toBe(false);
    expect(plan.message).toBeNull();
    expect(plan.execution.mode).toBe("navigate_only");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/kai/optimize",
        reason: "route_bound_action",
      },
    ]);
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
    expect(plan.actionId).toBe("nav.kai_dashboard");
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
    expect(plan.actionId).toBe("nav.profile_pkm_agent_lab");
    expect(plan.execution.mode).toBe("navigate_only");
    expect(plan.execution.steps).toEqual([
      {
        type: "navigate",
        href: "/profile/pkm-agent-lab",
        reason: "route_bound_action",
      },
    ]);
  });
});
