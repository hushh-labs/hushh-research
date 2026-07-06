import { describe, expect, it } from "vitest";

import { planOneGoal } from "@/lib/one-goal/one-goal-planner";

describe("planOneGoal", () => {
  it("asks for the next blocking source input for Analyze TSLA", () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA",
      entrypoint: "voice",
    });

    expect(plan.status).toBe("input_needed");
    if (plan.status !== "input_needed") return;
    expect(plan.goalId).toBe("goal.analysis.start_debate");
    expect(plan.action.action_id).toBe("analysis.start");
    expect(plan.slots.symbol).toBe("TSLA");
    expect(plan.prompt.slot).toBe("pickSource");
    expect(plan.prompt.prompt).toMatch(/Which list/i);
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
});
