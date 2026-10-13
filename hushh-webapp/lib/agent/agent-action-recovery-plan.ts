import {
  evaluateAgentActionRecovery,
  type AgentRecoveryPolicyDecision,
} from "@/lib/agent/agent-action-recovery";
import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { ROUTES } from "@/lib/navigation/routes";

const ANALYSIS_START_ACTION_ID = "analysis.start";

export type AgentActionRecoveryStep =
  | {
      id: "open_analysis_workspace";
      kind: "navigate";
      label: string;
      target: string;
    }
  | {
      id: "wait_for_analysis_workspace";
      kind: "wait_for_runtime";
      label: string;
      condition: "analysis_workspace_ready";
    }
  | {
      id: "confirm_analysis_start";
      kind: "request_consent";
      label: string;
      actionId: typeof ANALYSIS_START_ACTION_ID;
    }
  | {
      id: "execute_analysis_start";
      kind: "execute_action";
      label: string;
      actionId: typeof ANALYSIS_START_ACTION_ID;
      slots: {
        symbol: string;
      };
    }
  | {
      id: "verify_analysis_started";
      kind: "verify_effect";
      label: string;
      actionId: typeof ANALYSIS_START_ACTION_ID;
      acceptedEffectStates: Array<"started" | "completed">;
    };

export type AgentActionRecoveryPlan = {
  id: "analysis.start.open_workspace_then_execute";
  originalActionId: typeof ANALYSIS_START_ACTION_ID;
  title: string;
  summary: string;
  sourceReason: string | null;
  requiresFreshConsent: boolean;
  mayAutoExecute: false;
  policyDecision: AgentRecoveryPolicyDecision;
  steps: AgentActionRecoveryStep[];
};

export type BuildAgentActionRecoveryPlanInput = {
  result: AgentActionRuntimeResult;
  slots?: Record<string, unknown>;
};

function readSymbol(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const symbol = value.trim().toUpperCase();
  return symbol || null;
}

/**
 * Builds a deterministic recovery proposal for analysis.start.
 *
 * This function does not execute any step. It only returns a reviewable plan
 * after the fail-closed policy confirms that the first action never started.
 */
export function buildAgentActionRecoveryPlan(
  input: BuildAgentActionRecoveryPlanInput,
): AgentActionRecoveryPlan | null {
  if (
    input.result.actionId !== ANALYSIS_START_ACTION_ID ||
    input.result.status !== "blocked"
  ) {
    return null;
  }

  const symbol = readSymbol(input.slots?.symbol);
  if (!symbol) {
    return null;
  }

  const policyDecision = evaluateAgentActionRecovery({
    effectState: input.result.effectState,
    hasDeterministicRecovery: true,
    risk: "state_change",
    recoveryChangesAction: true,
  });

  if (policyDecision.disposition !== "propose") {
    return null;
  }

  return {
    id: "analysis.start.open_workspace_then_execute",
    originalActionId: ANALYSIS_START_ACTION_ID,
    title: `Start ${symbol} analysis safely`,
    summary:
      "Open the Analysis workspace, wait until it is ready, request fresh consent, start the analysis, and verify the resulting effect.",
    sourceReason: input.result.reason ?? null,
    requiresFreshConsent: policyDecision.requiresFreshConsent,
    mayAutoExecute: false,
    policyDecision,
    steps: [
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
        label: `Confirm starting an analysis for ${symbol}`,
        actionId: ANALYSIS_START_ACTION_ID,
      },
      {
        id: "execute_analysis_start",
        kind: "execute_action",
        label: `Start the ${symbol} analysis`,
        actionId: ANALYSIS_START_ACTION_ID,
        slots: {
          symbol,
        },
      },
      {
        id: "verify_analysis_started",
        kind: "verify_effect",
        label: "Verify that the analysis started",
        actionId: ANALYSIS_START_ACTION_ID,
        acceptedEffectStates: ["started", "completed"],
      },
    ],
  };
}
