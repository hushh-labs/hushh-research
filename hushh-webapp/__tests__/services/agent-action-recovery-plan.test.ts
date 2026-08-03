import { describe, expect, it } from "vitest";

import { buildAgentActionRecoveryPlan } from "@/lib/agent/agent-action-recovery-plan";
import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { ROUTES } from "@/lib/navigation/routes";

function createResult(
  overrides: Partial<AgentActionRuntimeResult> = {},
): AgentActionRuntimeResult {
  return {
    status: "blocked",
    effectState: "not_started",
    actionId: "analysis.start",
    label: "Start analysis",
    routeBefore: "/one",
    resultSummary: "Analysis is not available on the current screen.",
    reason: "unavailable",
    ...overrides,
  };
}

describe("buildAgentActionRecoveryPlan", () => {
  it("builds a deterministic analysis recovery proposal", () => {
    const plan = buildAgentActionRecoveryPlan({
      result: createResult(),
      slots: {
        symbol: "nvda",
      },
    });

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      id: "analysis.start.open_workspace_then_execute",
      originalActionId: "analysis.start",
      title: "Start NVDA analysis safely",
      sourceReason: "unavailable",
      requiresFreshConsent: true,
      mayAutoExecute: false,
      policyDecision: {
        disposition: "propose",
        reason: "safe_recovery_available",
        mayAutoRetry: false,
        requiresFreshConsent: true,
      },
    });

    expect(plan?.steps).toEqual([
      {
        id: "open_analysis_workspace",
        kind: "navigate",
        label: "Open the Analysis workspace",
        target: ROUTES.KAI_ANALYSIS,
      },
      {
        id: "wait_for_analysis_workspace",
        kind: "wait_for_runtime",
        label: "Wait until the Analysis workspace is ready",
        condition: "analysis_workspace_ready",
      },
      {
        id: "confirm_analysis_start",
        kind: "request_consent",
        label: "Confirm starting an analysis for NVDA",
        actionId: "analysis.start",
      },
      {
        id: "execute_analysis_start",
        kind: "execute_action",
        label: "Start the NVDA analysis",
        actionId: "analysis.start",
        slots: {
          symbol: "NVDA",
        },
      },
      {
        id: "verify_analysis_started",
        kind: "verify_effect",
        label: "Verify that the analysis started",
        actionId: "analysis.start",
        acceptedEffectStates: ["started", "completed"],
      },
    ]);
  });

  it("fails closed when the original effect is unknown", () => {
    expect(
      buildAgentActionRecoveryPlan({
        result: createResult({
          effectState: "unknown",
        }),
        slots: {
          symbol: "NVDA",
        },
      }),
    ).toBeNull();
  });

  it("does not recover when execution already started", () => {
    expect(
      buildAgentActionRecoveryPlan({
        result: createResult({
          status: "started",
          effectState: "started",
        }),
        slots: {
          symbol: "NVDA",
        },
      }),
    ).toBeNull();
  });

  it("does not recover a completed action", () => {
    expect(
      buildAgentActionRecoveryPlan({
        result: createResult({
          status: "succeeded",
          effectState: "completed",
        }),
        slots: {
          symbol: "NVDA",
        },
      }),
    ).toBeNull();
  });

  it("does not create a plan for another action", () => {
    expect(
      buildAgentActionRecoveryPlan({
        result: createResult({
          actionId: "connected_system.crm.read",
        }),
        slots: {
          symbol: "NVDA",
        },
      }),
    ).toBeNull();
  });

  it("does not create an incomplete plan without a symbol", () => {
    expect(
      buildAgentActionRecoveryPlan({
        result: createResult(),
      }),
    ).toBeNull();

    expect(
      buildAgentActionRecoveryPlan({
        result: createResult(),
        slots: {
          symbol: "   ",
        },
      }),
    ).toBeNull();
  });
});
