import { describe, expect, it } from "vitest";

import { planOneGoal } from "@/lib/one-goal/one-goal-planner";

describe("planOneGoal", () => {
  it("fills contract defaults instead of asking for pick source on Analyze TSLA", () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA",
      entrypoint: "voice",
    });

    // pick_source declares default_value "default" with a single option; a
    // natural agent flow uses the declared default rather than interrupting
    // the user with "Which list should Kai use for this debate?".
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.goalId).toBe("goal.analysis.start_debate");
    expect(plan.action.action_id).toBe("analysis.start");
    expect(plan.slots.symbol).toBe("TSLA");
    expect(plan.slots.pickSource).toBe("default");
  });

  it("still asks when a required input has no contract default", () => {
    const plan = planOneGoal({
      actionId: "analysis.start",
      // Every token here is a stop word or contract-dictionary token, so no
      // ticker can be resolved and the symbol prompt must fire.
      transcript: "start the stock debate",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("input_needed");
    if (plan.status !== "input_needed") return;
    expect(plan.prompt.slot).toBe("symbol");
    expect(plan.prompt.prompt).toMatch(/Which stock/i);
  });

  it("plans Analyze TSLA using default as a ready governed goal", () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA using default",
      entrypoint: "chat",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.goalId).toBe("goal.analysis.start_debate");
    expect(plan.action.action_id).toBe("analysis.start");
    expect(plan.slots).toMatchObject({
      symbol: "TSLA",
      pickSource: "default",
      pickSourceLabel: "Default list",
    });
  });

  it("resolves common company names into ticker slots without a stock-specific shortcut", () => {
    const plan = planOneGoal({
      transcript: "analyzing nvidia using default",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.goalId).toBe("goal.analysis.start_debate");
    expect(plan.action.action_id).toBe("analysis.start");
    expect(plan.slots).toMatchObject({
      symbol: "NVDA",
      pickSource: "default",
    });
  });

  it("overrides route-only provider proposals when transcript resolves a ticker goal", () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA using default",
      candidateActionId: "route.kai_analysis",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.action.action_id).toBe("analysis.start");
    expect(plan.slots).toMatchObject({
      symbol: "TSLA",
      pickSource: "default",
    });
  });

  it("asks for ticker first when analysis.start is proposed without a symbol", () => {
    const plan = planOneGoal({
      actionId: "analysis.start",
      slots: {
        pickSource: "default",
      },
      entrypoint: "command_bar",
    });

    expect(plan.status).toBe("input_needed");
    if (plan.status !== "input_needed") return;
    expect(plan.prompt.slot).toBe("symbol");
  });

  it("does not treat possessive pronouns from STT as ticker symbols", () => {
    // Regression: "stock analysis for Nvidia" was misheard as "stock for
    // YOUR"; "YOUR" matched the 1-5 uppercase ticker pattern and started a
    // real debate against a nonexistent company.
    const plan = planOneGoal({
      actionId: "analysis.start",
      transcript: "stock for your",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("input_needed");
    if (plan.status !== "input_needed") return;
    expect(plan.prompt.slot).toBe("symbol");
    expect(plan.slots.symbol).toBeUndefined();
  });

  it("never maps greetings or small talk to an action", () => {
    // Regression: "Hi" uppercased into "HI", a REAL listed ticker
    // (Hillenbrand). The unconditional ticker bonus made analysis.start the
    // top-ranked action for a bare greeting and chat ran a debate for "Hi".
    // A resolvable ticker must amplify existing intent, never create it.
    for (const transcript of ["Hi", "Hello", "hey there", "ok", "thanks"]) {
      const plan = planOneGoal({ transcript, entrypoint: "chat" });
      expect(
        plan.status === "ready" || plan.status === "input_needed"
          ? plan.action?.action_id
          : null,
        `"${transcript}" must not map to an action`
      ).not.toBe("analysis.start");
    }
  });

  it("explains the real prerequisite when state gating blocks the matched intent", () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA",
      entrypoint: "voice",
      appRuntimeState: {
        auth: { signed_in: true, user_id: "user_1" },
        vault: { unlocked: true, token_available: true, token_valid: true },
        route: { pathname: "/one/kai", screen: "kai_market", subview: null },
        runtime: {
          analysis_active: true,
          analysis_ticker: "NVDA",
          analysis_run_id: "run_1",
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
        voice: {
          available: true,
          tts_playing: false,
          last_tool_name: null,
          last_ticker: null,
        },
      },
    });

    // A debate is already running, so analysis_idle_required blocks a new
    // start. The plan must carry the matched intent and the true prerequisite
    // instead of a generic "could not map that request".
    expect(plan.status).toBe("blocked");
    if (plan.status !== "blocked") return;
    expect(plan.action?.action_id).toBe("analysis.start");
    expect(plan.reason).toMatch(/active analysis/i);
  });

  it("never overrides an explicit navigation intent with a ticker action", () => {
    // Regression: "navigate to Investor" was hijacked into analysis.start,
    // which then asked "Which list should Kai use for this debate?".
    const plan = planOneGoal({
      transcript: "navigate and take me to Investor",
      candidateActionId: "route.kai_home",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.action.action_id).toBe("route.kai_home");
  });
});
